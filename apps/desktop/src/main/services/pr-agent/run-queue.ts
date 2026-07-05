import type { PragentRunInfo } from '@meebox/ipc';
import { makeRunId } from '@meebox/poller';
import {
  AppError,
  ERROR_CODES,
  type ReviewRun,
  type ReviewRunTool,
  type StoredPullRequest,
} from '@meebox/shared';
import type { ServiceContext } from '../context.js';
import { RunExecutor } from './run-executor.js';

/** pr-agent run priority lane: user (manually initiated, high) / agent (orchestration / AutoPilot dispatch, low). */
export type RunPriority = 'user' | 'agent';

/**
 * Queue item: all context of one enqueued pr-agent run (including resolve/reject back to the original caller). Owned by the scheduler; the executor
 * (run-executor) references this type only via `import type`, and the type is erased at runtime, so it forms no runtime circular dependency.
 */
export interface QueueItem {
  info: PragentRunInfo;
  req: {
    localId: string;
    tool: ReviewRunTool;
    question?: string;
    referencedContext?: string;
    referencedFinding?: ReviewRun['referencedFinding'];
    scope?: ReviewRun['scope'];
  };
  pr: StoredPullRequest;
  resolve: (run: ReviewRun) => void;
  reject: (err: Error) => void;
  /** Priority lane: user (manually initiated, high) / agent (orchestration / AutoPilot dispatch, low). */
  priority: RunPriority;
  /** Filled only in active state; used for cancel SIGKILL */
  ac?: AbortController;
}

/**
 * pr-agent run queue service.
 *
 * FIFO queue, concurrency cap maxConcurrency (post-Docker, each run has an independent worktree + independent subprocess,
 * concurrency-safe). The rest queue in waiting; each time an active run completes / cancels → automatically pump the next one.
 *
 * Design points:
 *   - runId is assigned at enqueue (consistent with the finally-persisted ReviewRun.id), so cancel(runId) can precisely locate it
 *     in both active / waiting states
 *   - queued state is not persisted; when cancelled it directly rejects the original Promise, leaving no disk artifact
 *   - only on actual dequeue does startReviewRun write disk + run pr-agent
 *   - each queue change broadcasts 'pragent:queueChanged', syncing the renderer store
 *
 * The queue and running state (waiting / active / concurrency cap) are instance-mutable state, hence encapsulated in a class; PR domain operations
 * (mirror / diff base / adapter) are accessed via the injected ctx.pr.
 */
export class RunQueue {
  private readonly waiting: QueueItem[] = [];
  /** Concurrently running runs (runId → item); capped at maxConcurrency. */
  private readonly active = new Map<string, QueueItem>();
  /** Concurrency cap; hot-swappable via setMaxConcurrency (config:setMaxConcurrency). */
  private maxConcurrency: number;
  /** Run executor (persist / worktree / spawn / parse finalize); scheduling and execution are separated, this class only handles concurrency / priority / cancel. */
  private readonly executor: RunExecutor;

  constructor(private readonly ctx: ServiceContext) {
    this.maxConcurrency = ctx.bootstrap.config.pr_agent.max_concurrency;
    this.executor = new RunExecutor(ctx);
  }

  /**
   * Enqueue a pr-agent run (shares the same queue / concurrency / cancel mechanism as a user's manual run). dedup: if the same PR
   * with the same tool is already executing / queued, throw (/ask is unrestricted). Resolves the completed ReviewRun.
   */
  enqueuePragentRun(
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority: RunPriority = 'user',
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
    scope?: ReviewRun['scope'],
  ): Promise<ReviewRun> {
    const { logger } = this.ctx;
    // dedup only constrains same-tool duplicates for the "full PR"; /ask (a different question each time) and single-commit scope (a targeted action) are both let through
    // (allowing a per-commit review in addition to the full review, without treating them as duplicates).
    if (tool !== 'ask' && !scope) {
      const sameTask = (q: QueueItem): boolean =>
        q.info.prLocalId === pr.localId && q.info.tool === tool;
      if ([...this.active.values()].some(sameTask) || this.waiting.some(sameTask)) {
        throw new AppError(ERROR_CODES.AG_DUPLICATE_TASK, { tool });
      }
    }
    // Assign runId at enqueue; a later cancel(runId) can locate it in both waiting / active
    const runId = makeRunId(new Date());
    return new Promise<ReviewRun>((resolve, reject) => {
      const item: QueueItem = {
        info: {
          runId,
          prLocalId: pr.localId,
          repoSlug: pr.repo.repoSlug,
          prNumber: pr.remoteId,
          tool,
          question: tool === 'ask' ? question : undefined,
          origin: priority,
          scope,
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
        },
        // referencedContext / referencedFinding only go into req (in-memory state, not into info/PragentRunInfo) → not in the queue broadcast.
        // referencedFinding is persisted to the ReviewRun during run-executor startRun (forward-chain persistence).
        req: {
          localId: pr.localId,
          tool,
          question,
          referencedContext: tool === 'ask' ? referencedContext : undefined,
          referencedFinding: tool === 'ask' ? referencedFinding : undefined,
          // Single-commit scope applies to all tools (not just ask): the executor uses it to materialize the parent..sha worktree.
          scope,
        },
        pr,
        priority,
        resolve,
        reject,
      };
      // Priority jump-in: user tasks queue ahead of all agent tasks (still FIFO within the same lane); does not interrupt a running run.
      if (priority === 'user') {
        const firstAgentIdx = this.waiting.findIndex((q) => q.priority === 'agent');
        if (firstAgentIdx >= 0) this.waiting.splice(firstAgentIdx, 0, item);
        else this.waiting.push(item);
      } else {
        this.waiting.push(item);
      }
      logger.info(
        { runId, localId: pr.localId, tool, priority, queueLen: this.waiting.length },
        'pragent run enqueued',
      );
      this.pump();
    });
  }

  /**
   * Hot-swap the concurrency cap (config:setMaxConcurrency). After raising it, immediately pump the queue to fill the new slots; lowering it does not interrupt running runs,
   * converging naturally as they complete (pump only starts subsequent runs once active drops below the new cap).
   */
  setMaxConcurrency(max: number): void {
    this.maxConcurrency = max;
    this.pump();
  }

  /** Cancel one run (pragent:cancel): active→SIGKILL; waiting→dequeue + reject; neither matches→ok:false. */
  cancel(runId: string): { ok: boolean } {
    const { logger } = this.ctx;
    // active hit → SIGKILL (finally will write cancelled to disk)
    const running = this.active.get(runId);
    if (running) {
      logger.info({ runId }, 'pragent run cancel: active');
      running.ac?.abort();
      return { ok: true };
    }
    // waiting hit → remove from queue + reject the original Promise, no disk write (never actually ran)
    const idx = this.waiting.findIndex((q) => q.info.runId === runId);
    if (idx >= 0) {
      const [removed] = this.waiting.splice(idx, 1);
      logger.info({ runId, queueLen: this.waiting.length }, 'pragent run cancel: queued');
      removed!.reject(new Error('queued run cancelled'));
      this.broadcastQueueChanged();
      return { ok: true };
    }
    return { ok: false };
  }

  /** Current queue snapshot (for pragent:queue / broadcast). */
  snapshot(): { active: PragentRunInfo[]; waiting: PragentRunInfo[] } {
    return {
      active: [...this.active.values()].map((q) => q.info),
      waiting: this.waiting.map((q) => q.info),
    };
  }

  /** Cancel all runs for a PR: SIGKILL the active ones, dequeue + reject the waiting ones. */
  cancelRunsForPr(localId: string): void {
    for (const item of this.active.values()) if (item.req.localId === localId) item.ac?.abort();
    let removed = false;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i]!.req.localId === localId) {
        const [q] = this.waiting.splice(i, 1);
        q!.reject(new Error('pr removed'));
        removed = true;
      }
    }
    if (removed) this.broadcastQueueChanged();
  }

  /** Set of PR localIds involved in active + waiting (used by terminateAgentsForGonePrs). */
  queuedPrLocalIds(): string[] {
    const ids: string[] = [];
    for (const item of this.active.values()) ids.push(item.req.localId);
    for (const item of this.waiting) ids.push(item.req.localId);
    return ids;
  }

  /** Abort all in-progress runs on app exit, returning the number of aborted runs. */
  abortAllActiveRuns(): number {
    let n = 0;
    for (const item of this.active.values()) {
      item.ac?.abort();
      n++;
    }
    return n;
  }

  private broadcastQueueChanged(): void {
    this.ctx.broadcast('pragent:queueChanged', this.snapshot());
  }

  /**
   * Queue pump: while concurrency is below the cap and waiting is non-empty, continuously dequeue and start runs until maxConcurrency is filled.
   * After each run ends (success/failure/cancel) it is removed from active and the pump runs again, naturally continuing subsequent tasks.
   */
  private pump(): void {
    while (this.active.size < this.maxConcurrency && this.waiting.length > 0) {
      const item = this.waiting.shift()!;
      this.active.set(item.info.runId, item);
      item.ac = new AbortController();
      void this.executor
        .execute(item, () => this.broadcastQueueChanged())
        .then((finished) => item.resolve(finished))
        .catch((err: unknown) => {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.active.delete(item.info.runId);
          this.broadcastQueueChanged();
          // Pump again in a microtask to avoid recursive stack buildup
          queueMicrotask(() => this.pump());
        });
    }
    this.broadcastQueueChanged();
  }
}
