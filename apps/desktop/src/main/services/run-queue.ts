import type { PragentRunInfo } from '@meebox/ipc';
import { makeRunId } from '@meebox/poller';
import type { ReviewRun, ReviewRunTool, StoredPullRequest } from '@meebox/shared';
import { t } from '../i18n/index.js';
import type { ServiceContext } from './context.js';
import { PragentRunExecutor } from './run-executor.js';
import type { QueueItem, RunPriority } from './run-queue-types.js';

export type { RunPriority } from './run-queue-types.js';

/**
 * pr-agent run 队列服务。
 *
 * FIFO 队列，并发上限 maxConcurrency（post-Docker 下每个 run 独立 worktree + 独立子进程，
 * 并发安全）。其余在 waiting 排队；每次 active 完成 / 取消 → 自动泵下一条。
 *
 * 设计要点：
 *   - runId 在入队时就分配（跟最终落盘 ReviewRun.id 一致），cancel(runId) 在 active / waiting
 *     两种状态都能精确定位
 *   - queued 状态不落盘；被取消时直接 reject 原 Promise，不留 disk artifact
 *   - 真正 dequeue 才 startReviewRun 写 disk + 跑 pr-agent
 *   - 每次队列变化广播 'pragent:queueChanged'，renderer store 同步
 *
 * 队列与运行态（waiting / active / 并发上限）是实例可变状态，故以 class 封装；PR 领域操作
 * （镜像 / diff base / adapter）经注入的 ctx.pr 取用。
 */
export class RunQueueService {
  private readonly waiting: QueueItem[] = [];
  /** 并发运行中的 run（runId → item）；上限 maxConcurrency。 */
  private readonly active = new Map<string, QueueItem>();
  private readonly maxConcurrency: number;
  /** run 执行器（落盘 / worktree / spawn / 解析收尾）；调度与执行分离，本类只负责并发 / 优先级 / 取消。 */
  private readonly executor: PragentRunExecutor;

  constructor(private readonly ctx: ServiceContext) {
    this.maxConcurrency = ctx.bootstrap.config.pr_agent.max_concurrency;
    this.executor = new PragentRunExecutor(ctx);
  }

  /**
   * 入队一个 pr-agent run（与用户手动 run 共用同一队列 / 并发 / 取消机制）。dedup：同 PR
   * 同工具已在执行 / 排队则抛错（/ask 不限）。resolve 完成的 ReviewRun。
   */
  enqueuePragentRun(
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority: RunPriority = 'user',
    referencedContext?: string,
  ): Promise<ReviewRun> {
    const { logger } = this.ctx;
    if (tool !== 'ask') {
      const sameTask = (q: QueueItem): boolean =>
        q.info.prLocalId === pr.localId && q.info.tool === tool;
      if ([...this.active.values()].some(sameTask) || this.waiting.some(sameTask)) {
        throw new Error(t('prAgent.duplicateTask', { tool }));
      }
    }
    // 入队时就分配 runId；后续 cancel(runId) 在 waiting / active 都能定位
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
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
        },
        // referencedContext 仅入 req（内存态，不进 info/PragentRunInfo）→ 不落盘、不进队列广播。
        req: { localId: pr.localId, tool, question, referencedContext: tool === 'ask' ? referencedContext : undefined },
        pr,
        priority,
        resolve,
        reject,
      };
      // 优先级插队：user 任务排到所有 agent 任务之前（同泳道内仍 FIFO）；不打断在跑的 run。
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

  /** 取消一个 run（pragent:cancel）：active→SIGKILL；waiting→出队 + reject；都不匹配→ok:false。 */
  cancel(runId: string): { ok: boolean } {
    const { logger } = this.ctx;
    // active 命中 → SIGKILL (finally 会写 cancelled 到 disk)
    const running = this.active.get(runId);
    if (running) {
      logger.info({ runId }, 'pragent run cancel: active');
      running.ac?.abort();
      return { ok: true };
    }
    // waiting 命中 → 从队列删除 + reject 原 Promise，不写盘 (从未真正跑过)
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

  /** 当前队列快照（pragent:queue / 广播用）。 */
  snapshot(): { active: PragentRunInfo[]; waiting: PragentRunInfo[] } {
    return {
      active: [...this.active.values()].map((q) => q.info),
      waiting: this.waiting.map((q) => q.info),
    };
  }

  /** 取消某 PR 的全部 run：active 的 SIGKILL，waiting 的出队 + reject。 */
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

  /** active + waiting 涉及的 PR localId 集合（terminateAgentsForGonePrs 用）。 */
  queuedPrLocalIds(): string[] {
    const ids: string[] = [];
    for (const item of this.active.values()) ids.push(item.req.localId);
    for (const item of this.waiting) ids.push(item.req.localId);
    return ids;
  }

  /** 应用退出时中止所有进行中的 run，返回被中止的 run 数。 */
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
   * 队列泵：在并发未达上限且 waiting 非空时，连续 dequeue 起跑，直到填满 maxConcurrency。
   * 每条 run 结束（成功/失败/取消）后从 active 移除并再泵一次，自然续上后续任务。
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
          // 放微任务里再泵，避免递归栈累积
          queueMicrotask(() => this.pump());
        });
    }
    this.broadcastQueueChanged();
  }
}
