import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendAgentMessage, readPrIndex, writeAutopilotLedger } from '@meebox/poller';
import { buildChatEnv } from '@meebox/pr-agent-bridge';
import {
  AppError,
  ERROR_CODES,
  type AgentSession,
  type AgentStep,
  type StoredPullRequest,
} from '@meebox/shared';
import { getMainLanguage } from '../../i18n/index.js';
import { resolveActiveLlmProfile } from '../../utils/agent.js';
import { buildProxyEnv } from '../../utils/proxy.js';
import type { ServiceContext } from '../context.js';
import type { RunQueue } from '../pr-agent/index.js';
import { accumulateUsageSentinel, finalizeUsage, newUsageAcc } from '../pr-agent/usage.js';
import { autopilotPass } from './flows/autopilot.js';
import { planningFlow } from './flows/planning.js';
import { reviewFlow } from './flows/review.js';
import type { AgentChat, OrchestratorRuntime } from './runtime.js';

/**
 * Agent orchestration service (stateful coordinator): manual review (agent:run), free-form planning
 * (agent:ask), AutoPilot background pre-review, plus cleanup of in-flight ops on PRs that have vanished
 * on each poll tick. Runtime state (per-PR AbortController, "running" set, AutoPilot busy lock, mid-run
 * input queue) is instance-mutable state, so it is wrapped in a class implementing OrchestratorRuntime——
 * exposing state access + shared helpers (withAgentChat / summary landing / step broadcast, etc.) to the
 * flows split one-task-per-file (see ./flows).
 */
export class Orchestrator implements OrchestratorRuntime {
  // At most one orchestrator agent runs per PR; AbortController lets agent:stop abort instantly——can stop at any stage of thinking / tool execution.
  private readonly agentControllers = new Map<string, AbortController>();
  // Set of PRs whose orchestrator agent is running (thinking or dispatching tools), broadcast "running" to
  // renderer. Manual run/ask and AutoPilot background review both count, so PR list items show the running
  // mark even in the pure-thinking stage (no active tool run).
  private readonly runningAgentPrs = new Set<string>();
  // Global single-concurrency at the agent orchestration layer: run at most one AutoPilot pass at a time (busy lock), preventing a new pass stacking on an unfinished one.
  private autopilotBusy = false;
  // Mid-run input redirect: one pending user-message queue per PR (appended while running → enqueued, injected via drain next cycle).
  private readonly pendingInputByPr = new Map<string, string[]>();

  constructor(
    readonly ctx: ServiceContext,
    readonly runQueue: RunQueue,
  ) {}

  // ── Public API (IPC entry points; delegates to the per-task flows under ./flows) ──

  /** Run the review micro-flow on the given PR (agent:run). */
  runReview(pr: StoredPullRequest): Promise<AgentSession> {
    return reviewFlow(this, pr);
  }

  /** Run the free-form planning agent on the given PR (agent:ask). */
  runPlanning(
    pr: StoredPullRequest,
    question: string,
    referencedContext?: string,
  ): Promise<AgentSession> {
    return planningFlow(this, pr, question, referencedContext);
  }

  /**
   * Append a user message during a run (agent:enqueueMessage): an agent is running → enqueue, injected via
   * drain on the next main-agent cycle (queued=true); none running → directly start a free-form planning
   * fallback (queued=false, fire-and-forget, no message dropped).
   */
  enqueueMessage(pr: StoredPullRequest, message: string): { queued: boolean } {
    const text = message.trim();
    if (!text) return { queued: false };
    if (this.agentControllers.has(pr.localId)) {
      const q = this.pendingInputByPr.get(pr.localId) ?? [];
      q.push(text);
      this.pendingInputByPr.set(pr.localId, q);
      this.ctx.logger.info(
        { prLocalId: pr.localId, queueLen: q.length },
        'agent message queued (mid-run)',
      );
      return { queued: true };
    }
    // Race fallback: found none running → directly start a free-form planning round (UI updates via step / conversation events).
    void this.runPlanning(pr, text).catch((err: unknown) => {
      this.ctx.logger.warn({ err, prLocalId: pr.localId }, 'enqueueMessage fallback planning failed');
    });
    return { queued: false };
  }

  /** Pause a PR's agent run (agent:stop): abort its AbortController. */
  stop(localId: string): { ok: boolean } {
    const ac = this.agentControllers.get(localId);
    if (!ac) return { ok: false };
    ac.abort();
    return { ok: true };
  }

  /**
   * poll tick: when switch on + not running + bridge ready, run one AutoPilot pass (admission gating +
   * ledger dedup live inside autopilotPass). The busy lock prevents a new pass stacking on an unfinished
   * one. See docs/arch/02-agent/03-autopilot.md "AutoPilot".
   */
  runAutopilotIfDue(): void {
    const ap = this.ctx.bootstrap.config.agent.autopilot;
    if (!ap.enabled || this.autopilotBusy || !this.ctx.getPrAgentBridge()) return;
    // Admission passed → fire-and-forget async pass (poll tick not blocked); busy lock managed in pairs inside autopilotPass.
    void autopilotPass(this);
  }

  /**
   * Called after a poll tick: terminate any agent ops still in flight on PRs that have been purged (fully
   * removed from the index)——the PR is gone, so continuing the review is pointless and wastes LLM /
   * occupies a worktree.
   *
   * "Presence" is judged against the **full index** (active + archived, readPrIndex covers both), not just
   * the active set——otherwise, when re-running AI review on an **archived** (closed-scope) PR, the next poll
   * would mistake it for "removed" and cut it off midway (an archived PR is still in the index, just with a
   * non-empty archivedAt). Terminate only when an entry is entirely absent from the index (hard-cleaned
   * after the grace period).
   */
  async terminateAgentsForGonePrs(): Promise<void> {
    const { stateStore, logger } = this.ctx;
    const opPrIds = new Set<string>();
    for (const id of this.agentControllers.keys()) opPrIds.add(id);
    for (const id of this.runQueue.queuedPrLocalIds()) opPrIds.add(id);
    if (opPrIds.size === 0) return;
    const index = await readPrIndex(stateStore);
    const live = new Set(Object.keys(index?.prs ?? {}));
    for (const id of opPrIds) {
      if (!live.has(id)) {
        logger.info({ prLocalId: id }, 'agent ops terminated: pr removed/purged');
        this.terminateAgentForPr(id);
      }
    }
  }

  // ── OrchestratorRuntime implementation (state access + shared helpers reused by ./flows) ──

  registerController(localId: string, ac: AbortController): void {
    this.agentControllers.set(localId, ac);
  }

  clearController(localId: string): void {
    this.agentControllers.delete(localId);
  }

  markRunning(localId: string): void {
    this.runningAgentPrs.add(localId);
    this.broadcastAgentRunning();
  }

  unmarkRunning(localId: string): void {
    if (this.runningAgentPrs.delete(localId)) this.broadcastAgentRunning();
  }

  setAutopilotBusy(busy: boolean): void {
    this.autopilotBusy = busy;
  }

  /** Take and clear a PR's pending user-message queue. */
  takePending(localId: string): string[] {
    const q = this.pendingInputByPr.get(localId);
    if (!q || q.length === 0) return [];
    this.pendingInputByPr.delete(localId);
    return q;
  }

  /**
   * Unified exit for every orchestration step: ① background log (kind / tool / elapsed, for troubleshooting
   * and offline replay; thought and result are not logged to avoid flooding + leakage, the full step is
   * already persisted to transcript.json); ② broadcast to the renderer (agent:stepProgress) for progressive
   * display.
   */
  emitStep(pr: StoredPullRequest, sessionId: string, step: AgentStep): void {
    this.ctx.logger.info(
      {
        prLocalId: pr.localId,
        sessionId,
        kind: step.kind,
        tool: step.toolCall?.tool,
        thinkMs: step.thinkMs,
      },
      'agent step',
    );
    this.ctx.broadcast('agent:stepProgress', { sessionId, prLocalId: pr.localId, step });
  }

  /** Set up LLM env + temp chat cwd + chat function, run fn, then clean up the temp dir on finish.
   *  signal: on user stop, abort → kill the running LLM chat subprocess, so the thinking stage can also abort immediately (no need to wait for the model to return). */
  async withAgentChat<T>(fn: (chat: AgentChat) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { getPrAgentBridge, bootstrap } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
    // Reuse the same LLM env as a pr-agent run (provider credentials / model / proxy / response language).
    // Proxy env is laid down first (outside pr-agent scope); LLM credentials/model + orchestration-chat
    // specific settings (response language / low-reasoning tier / prompt cache) are assembled by buildChatEnv
    // per intent. The low tier and cache apply only to this chat spawn: the env of pr-agent tool runs
    // (/review etc.) does not include them → still full-tier reasoning.
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...buildChatEnv(activeLlm, {
        responseLanguage: getMainLanguage(),
        lowReasoning: true,
        promptCache: true,
        maxModelTokens: bootstrap.config.llm.context_tokens,
      }),
    };
    // The chat subprocess runs in a neutral temp dir (in cli mode, avoids picking up the reviewed repo's CLAUDE.md).
    const chatCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-agent-chat-'));
    try {
      const chat: AgentChat = async ({ system, user, maxOutputTokens }) => {
        const r = await bridge.chat({ system, user, maxOutputTokens, env, cwd: chatCwd, signal });
        const acc = newUsageAcc();
        for (const line of (r.stderr ?? '').split('\n')) accumulateUsageSentinel(line, acc);
        return { text: r.stdout.trim(), usage: finalizeUsage(acc) };
      };
      return await fn(chat);
    } finally {
      await fs.rm(chatCwd, { recursive: true, force: true });
    }
  }

  /**
   * Unified landing for review summary finish (shared by manual one-click review and AutoPilot background
   * review): only when finished successfully (done) and a summary exists——
   * ① append one assistant review message (UI renders the "review summary" card); ② write the review ledger
   *    (recommendation + current updatedAt, feeding the PR list suggestion badge + AutoPilot same-version
   *    dedup). On failure / user stop (paused) nothing is landed, for easy retry.
   */
  async recordReviewSummaryMessage(pr: StoredPullRequest, session: AgentSession): Promise<void> {
    if (session.status !== 'done' || !session.summary) return;
    // per-PR storage routing: for a re-run review on an archived (closed-scope) PR, the summary message / ledger lands in archived cold storage.
    const store = await this.ctx.pr.storeForPr(pr.localId);
    await appendAgentMessage(store, pr.localId, {
      role: 'assistant',
      content: session.summary,
      recommendation: session.recommendation,
    });
    await writeAutopilotLedger(store, {
      prLocalId: pr.localId,
      autoReviewedUpdatedAt: pr.updatedAt,
      decision: 'review',
      recommendation: session.recommendation?.verdict,
      at: new Date().toISOString(),
    });
    // Notify the renderer: if this PR is open, reloading the conversation makes the background review's "review summary" card appear instantly (manual review reloads itself, so the duplicate is harmless).
    this.ctx.broadcast('agent:conversationChanged', { prLocalId: pr.localId });
  }

  // ── Private helpers ──

  private broadcastAgentRunning(): void {
    this.ctx.broadcast('agent:runningChanged', { prLocalIds: [...this.runningAgentPrs] });
  }

  /** Terminate all agent ops on a PR: abort orchestration (agent:run/ask) + cancel the tool runs it dispatched. */
  private terminateAgentForPr(localId: string): void {
    this.agentControllers.get(localId)?.abort();
    this.runQueue.cancelRunsForPr(localId);
  }
}
