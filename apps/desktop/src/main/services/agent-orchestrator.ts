import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendAgentNotes,
  buildToolCatalog,
  judgeAutopilotBatch,
  loadAgentContext,
} from '@meebox/agent';
import type { AgentContext } from '@meebox/agent';
import {
  appendAgentMessage,
  getAutopilotLedger,
  hasReviewOutput,
  listStoredPullRequests,
  writeAutopilotLedger,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type { AgentSession, AgentStep, StoredPullRequest, TokenUsage } from '@meebox/shared';
import { runAgentPlanning } from '../agent-planning.js';
import { runAgentReview } from '../agent-review.js';
import { getMainLanguage, t } from '../i18n/index.js';
import { buildPragentEnv, resolveActiveLlmProfile } from '../utils/agent.js';
import { buildProxyEnv } from '../utils/proxy.js';
import { accumulateUsageSentinel, finalizeUsage, newUsageAcc } from './usage.js';
import type { ServiceContext } from './context.js';
import type { RunQueueService } from './run-queue.js';

// 共享 chat 通道：system + user → 文本 + usage。agent:run 评审与 AutoPilot 都用。
type AgentChat = (input: {
  system: string;
  user: string;
}) => Promise<{ text: string; usage?: TokenUsage }>;

export interface AgentOrchestratorService {
  /** 对指定 PR 跑评审微流程（agent:run）：装配上下文 + 注册中止 + 收尾落总结。 */
  runReview(pr: StoredPullRequest): Promise<AgentSession>;
  /** 对指定 PR 跑自由规划 Agent（agent:ask）。 */
  runPlanning(pr: StoredPullRequest, question: string): Promise<AgentSession>;
  /** 暂停某 PR 的 Agent 运行（agent:stop）。 */
  stop(localId: string): { ok: boolean };
  /** poll tick：满足开关 + 候选时跑一遍 AutoPilot pass（内部门控）。 */
  runAutopilotIfDue(): void;
  /** poll tick：终止已被移除 / purge 的 PR 上仍在执行的 agent 操作。 */
  terminateAgentsForGonePrs(): Promise<void>;
}

export function createAgentOrchestratorService(
  ctx: ServiceContext,
  runQueue: RunQueueService,
): AgentOrchestratorService {
  const { bootstrap, logger, stateStore, getPrAgentBridge, broadcast, effectiveAgentDir } = ctx;
  const { enqueuePragentRun, cancelRunsForPr, queuedPrLocalIds } = runQueue;

  /** 设置 LLM env + 临时 chat cwd + chat 函数，运行 fn，收尾清理临时目录。
   *  signal：用户停止时 abort → 杀掉在跑的 LLM chat 子进程，让思考阶段也能立即中止（不必等模型返回）。 */
  const withAgentChat = async <T>(
    fn: (chat: AgentChat) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const bridge = getPrAgentBridge();
    if (!bridge) throw new Error(t('prAgent.notReadyDetail'));
    // 复用与 pr-agent run 同一套 LLM env（provider 凭据 / 模型 / 代理 / 响应语言）。
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
      CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
      // Agent 编排通道（规划 / 判读 / 收尾 / 对话）是路由 + 轻量综合，非深度代码分析（那在
      // pr-agent /review 里）。本机 CLI 模式下调低推理档（codex: model_reasoning_effort=minimal）
      // 提速；仅作用于本 chat spawn，pr-agent 工具 run 的 env 不含此项 → /review 仍满档推理。
      // 非 CLI 模式（API）由 CLI handler 之外的路径处理，该 env 无副作用。
      MEEBOX_CLI_REASONING: 'low',
    };
    // chat 子进程落到中性临时目录（cli 模式避免吃到被评审仓库的 CLAUDE.md）。
    const chatCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-agent-chat-'));
    try {
      const chat: AgentChat = async ({ system, user }) => {
        const r = await bridge.chat({ system, user, env, cwd: chatCwd, signal });
        const acc = newUsageAcc();
        for (const line of (r.stderr ?? '').split('\n')) accumulateUsageSentinel(line, acc);
        return { text: r.stdout.trim(), usage: finalizeUsage(acc) };
      };
      return await fn(chat);
    } finally {
      await fs.rm(chatCwd, { recursive: true, force: true });
    }
  };

  /**
   * 每个编排步骤的统一出口：① 后台日志（工具选择 / 判读 / 收尾各落一条，便于排障与离线回看）；
   * ② 广播给渲染层（agent:stepProgress）做过程化展示。thought / result 截断避免刷屏。
   */
  // 后台日志只留骨架（kind / tool / 用时）：thought 与 result（含用户输入 / 总结正文）不入日志，
  // 避免刷屏 + 泄漏内容；完整步骤已落 transcript.json，需要时从那里回看。
  const emitAgentStep = (pr: StoredPullRequest, sessionId: string, step: AgentStep): void => {
    logger.info(
      {
        prLocalId: pr.localId,
        sessionId,
        kind: step.kind,
        tool: step.toolCall?.tool,
        thinkMs: step.thinkMs,
      },
      'agent step',
    );
    broadcast('agent:stepProgress', { sessionId, prLocalId: pr.localId, step });
  };

  // 编排 Agent（手动评审 agent:run + 自由规划 agent:ask）每 PR 至多一个在跑，AbortController 供
  // agent:stop 即时中止——思考 / 工具执行任意阶段都能停。
  const agentControllers = new Map<string, AbortController>();

  // 运行中（思考或派发工具）的编排 Agent 所属 PR 集合，向 renderer 广播「执行中」。区别于
  // agentControllers（仅手动可停会话）：这里**手动 run/ask 与 AutoPilot 后台评审一并计入**，
  // 让 PR 列表项在纯思考阶段（无活跃工具 run）也显示执行中标记。
  const runningAgentPrs = new Set<string>();
  const broadcastAgentRunning = (): void => {
    broadcast('agent:runningChanged', { prLocalIds: [...runningAgentPrs] });
  };
  const markAgentRunning = (localId: string): void => {
    runningAgentPrs.add(localId);
    broadcastAgentRunning();
  };
  const unmarkAgentRunning = (localId: string): void => {
    if (runningAgentPrs.delete(localId)) broadcastAgentRunning();
  };

  /** 终止某 PR 上的全部 agent 操作：中止编排（agent:run/ask）+ 取消其派发的工具 run。 */
  const terminateAgentForPr = (localId: string): void => {
    agentControllers.get(localId)?.abort();
    cancelRunsForPr(localId);
  };

  /**
   * poll tick 后调用：把已被移除 / purge（不再在 listStoredPullRequests 里）的 PR 上仍在执行的
   * agent 操作一律直接终止——PR 都没了，继续评审无意义且浪费 LLM / 占用 worktree。
   */
  const terminateAgentsForGonePrs = async (): Promise<void> => {
    const opPrIds = new Set<string>();
    for (const id of agentControllers.keys()) opPrIds.add(id);
    for (const id of queuedPrLocalIds()) opPrIds.add(id);
    if (opPrIds.size === 0) return;
    const live = new Set((await listStoredPullRequests(stateStore)).map((p) => p.localId));
    for (const id of opPrIds) {
      if (!live.has(id)) {
        logger.info({ prLocalId: id }, 'agent ops terminated: pr removed/purged');
        terminateAgentForPr(id);
      }
    }
  };

  /** 对一个 PR 跑评审微流程（共用 enqueue 队列 / 持久化 / 步骤广播）。 */
  const runReviewForPr = (
    pr: StoredPullRequest,
    agentContext: AgentContext,
    chat: AgentChat,
    signal?: AbortSignal,
    autopilot = false,
  ): Promise<AgentSession> => {
    const agentCfg = bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentReview(pr, {
      stateStore,
      // 编排派发的 run 走 agent 低优先级泳道：用户随时点 /review 会插到它们之前。
      enqueueRun: (p, tool, question) => enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      matchedRule,
      language: getMainLanguage(),
      // 工具目录注入：修改类工具按 grants 门控（默认全禁，红线见 buildToolCatalog）。
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      maxFollowupAsks: agentCfg.autopilot.max_followup_asks,
      summaryMaxChars: agentCfg.summary_max_chars,
      onStep: (sessionId, step) => emitAgentStep(pr, sessionId, step),
      signal,
      autopilot,
    });
  };

  /**
   * 评审收尾的统一落地（手动一键评审与 AutoPilot 背景评审共用）：仅成功收尾（done）且有总结时——
   * ① 追加一条 assistant 评审消息（UI 渲染「评审总结」卡片）；② 写评审台账（recommendation + 当前
   *    updatedAt）。台账既给 PR 列表的建议徽标（★，手动 / 自动一视同仁），也供 AutoPilot 同版本去重。
   * 失败 / 用户停止（paused）不落，便于后续重试。
   */
  const recordReviewSummaryMessage = async (
    pr: StoredPullRequest,
    session: AgentSession,
  ): Promise<void> => {
    if (session.status !== 'done' || !session.summary) return;
    await appendAgentMessage(stateStore, pr.localId, {
      role: 'assistant',
      content: session.summary,
      recommendation: session.recommendation,
    });
    await writeAutopilotLedger(stateStore, {
      prLocalId: pr.localId,
      autoReviewedUpdatedAt: pr.updatedAt,
      decision: 'review',
      recommendation: session.recommendation?.verdict,
      at: new Date().toISOString(),
    });
    // 通知渲染层：若正打开该 PR，重载会话让后台评审的「评审总结」卡片即时出现（手动评审自行重载，重复无害）。
    broadcast('agent:conversationChanged', { prLocalId: pr.localId });
  };

  const runReview = async (pr: StoredPullRequest): Promise<AgentSession> => {
    if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
    // 现读现装配 Agent 上下文（SOUL/AGENTS/MEMORY/USER + rules），无缓存。
    const agentContext = await loadAgentContext(effectiveAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    // 注册 AbortController，让停止按钮（agent:stop）能在思考 / 执行任意阶段即时中止本次评审。
    const ac = new AbortController();
    agentControllers.set(pr.localId, ac);
    markAgentRunning(pr.localId);
    logger.info({ prLocalId: pr.localId }, 'agent review start (manual)');
    try {
      const session = await withAgentChat(
        (chat) => runReviewForPr(pr, agentContext, chat, ac.signal),
        ac.signal,
      );
      logger.info(
        { prLocalId: pr.localId, status: session.status, steps: session.stepCount },
        'agent review done',
      );
      // 收尾总结计入多轮对话（assistant 评审消息）→ UI 渲染「评审总结」卡片。
      await recordReviewSummaryMessage(pr, session);
      return session;
    } finally {
      agentControllers.delete(pr.localId);
      unmarkAgentRunning(pr.localId);
    }
  };

  const runPlanningForPr = (
    pr: StoredPullRequest,
    userRequest: string,
    agentContext: AgentContext,
    chat: AgentChat,
    signal: AbortSignal,
  ): Promise<AgentSession> => {
    const agentCfg = bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentPlanning(pr, userRequest, {
      stateStore,
      enqueueRun: (p, tool, question) => enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      matchedRule,
      language: getMainLanguage(),
      maxSteps: agentCfg.max_steps,
      signal,
      onStep: (sessionId, step) => emitAgentStep(pr, sessionId, step),
      // 持久化 Agent 主动记下的非隐私条目到当前 Agent 目录的各可写文件（USER/MEMORY/AGENTS）；
      // SOUL.md 永不写。下一轮 loadAgentContext 现读即生效（跨会话记忆）。
      recordMemory: async (notes) => {
        const dir = effectiveAgentDir();
        for (const kind of ['user', 'memory', 'agents'] as const) {
          const added = await appendAgentNotes(dir, kind, notes[kind]).catch((err: unknown) => {
            logger.warn({ err, kind }, 'record agent memory failed');
            return [] as string[];
          });
          if (added.length) logger.info({ kind, added }, 'agent memory recorded');
        }
      },
    });
  };

  const runPlanning = async (pr: StoredPullRequest, question: string): Promise<AgentSession> => {
    if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
    const agentContext = await loadAgentContext(effectiveAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    const ac = new AbortController();
    agentControllers.set(pr.localId, ac);
    markAgentRunning(pr.localId);
    // 不记用户输入正文（避免泄漏 / 刷屏）：只记发起本身，输入已落多轮对话。
    logger.info({ prLocalId: pr.localId }, 'agent chat start (planning)');
    try {
      const session = await withAgentChat(
        (chat) => runPlanningForPr(pr, question, agentContext, chat, ac.signal),
        ac.signal,
      );
      logger.info(
        {
          prLocalId: pr.localId,
          status: session.status,
          steps: session.stepCount,
          terminationReason: session.terminationReason,
        },
        'agent chat done',
      );
      return session;
    } finally {
      agentControllers.delete(pr.localId);
      unmarkAgentRunning(pr.localId);
    }
  };

  const stop = (localId: string): { ok: boolean } => {
    const ac = agentControllers.get(localId);
    if (!ac) return { ok: false };
    ac.abort();
    return { ok: true };
  };

  // === AutoPilot 调度（见 docs/arch/06-agent.md「AutoPilot」）===
  // Agent 编排层全局单并发：一次只跑一遍 pass（busy 锁）；其派发的工具 run 在共享队列并行。
  // 触发节奏对齐轮询：每个 poller onTick（间隔 = poller.interval_seconds）评估一遍，不再另设独立的最小
  // 间隔守卫——准入门控 + 台账去重已防止重复评审 / 打爆 LLM；busy 锁防止上一遍未完又叠跑。
  let autopilotBusy = false;
  const runAutopilotIfDue = (): void => {
    const ap = bootstrap.config.agent.autopilot;
    if (!ap.enabled || autopilotBusy || !getPrAgentBridge()) {
      return;
    }
    autopilotBusy = true;
    void (async () => {
      try {
        // 候选准入（硬性门控，自上而下）：
        //   1. 仅「待我评审」分类（discoveryFilters 含 review-requested）下、「待处理」状态（localStatus
        //      === 'pending'）的 PR —— 已通过 / 标记需修改、或非待我评审的一律不自动评审。
        //      （不支持发现分类的平台 discoveryFilters 为空 → 不命中，自然不自动触发。）
        //   2. 会话中已有 /describe 或 /review 产出（成功 / 正在跑，手动或自动）→ 判定已评审过 / 评审中，
        //      不再自动触发（评审失败无产出 → 不算，下轮可重试）。
        //   3. 仅排除「本版本已被判定跳过」的 PR（台账 decision='skipped'）——避免对判过 skip 的 PR 反复
        //      重判；无产出又未被 skip 的待评审 PR 一律放行（不再因台账有任意记录就拦下）。
        //   再按 batch_size 截断。
        const prs = await listStoredPullRequests(stateStore);
        const candidates: StoredPullRequest[] = [];
        // 准入漏斗计数（用于 0 候选时定位卡在哪一道闸——便于排查「为何不再触发」）。
        let reviewReqPending = 0; // 命中「待我评审 + 待处理」
        let alreadyReviewed = 0; // 其中已有 describe/review 产出（成功 / 进行中）而被排除
        let skipDeduped = 0; // 其中本版本已被判定跳过而被排除
        for (const pr of prs) {
          if (candidates.length >= ap.batch_size) break;
          if (!pr.discoveryFilters.includes('review-requested')) continue;
          if (pr.localStatus !== 'pending') continue;
          reviewReqPending++;
          if (await hasReviewOutput(stateStore, pr.localId)) {
            alreadyReviewed++;
            continue;
          }
          const ledger = await getAutopilotLedger(stateStore, pr.localId);
          if (ledger?.decision === 'skipped' && ledger.autoReviewedUpdatedAt === pr.updatedAt) {
            skipDeduped++;
            continue;
          }
          candidates.push(pr);
        }
        if (candidates.length === 0) {
          // 仍在按周期评估，只是当前无新合格 PR——把漏斗计数打出来，避免被误读成「没在跑」。
          logger.info(
            { total: prs.length, reviewReqPending, alreadyReviewed, skipDeduped },
            'autopilot pass: no eligible candidates',
          );
          return;
        }

        const agentContext = await loadAgentContext(effectiveAgentDir(), {
          onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
        });
        await withAgentChat(async (chat) => {
          // 批量判定（例外规则来自 AGENTS.md）。
          const { decisions } = await judgeAutopilotBatch(chat, {
            candidates: candidates.map((p) => ({
              prLocalId: p.localId,
              title: p.title,
              description: p.description,
            })),
            agentsRules: agentContext.files.agents,
          });
          const byId = new Map(candidates.map((p) => [p.localId, p] as const));
          // 先落「跳过」决策（无工具开销，顺序写盘即可）；收集「评审」决策待并行编排。
          const toReview: StoredPullRequest[] = [];
          for (const d of decisions) {
            const pr = byId.get(d.prLocalId);
            if (!pr) continue;
            if (!d.review) {
              // 输出判定 skip 的原因（候选都已过准入闸、非「已评审」，故这里的原因都是 LLM 的领域判定，
              // 如分支合并 / 纯依赖升级 — 打出来便于核对「为何没评审这个 PR」）。
              logger.info({ prLocalId: pr.localId, reason: d.reason }, 'autopilot judge skip');
              await writeAutopilotLedger(stateStore, {
                prLocalId: pr.localId,
                autoReviewedUpdatedAt: pr.updatedAt,
                decision: 'skipped',
                reason: d.reason,
                at: new Date().toISOString(),
              });
              continue;
            }
            toReview.push(pr);
          }
          // 多 PR 评审并行编排：各编排 await 自己的工具 run 时彼此不挡，让工具的并发队列
          // （run-queue maxConcurrency）尽量被填满，而非逐 PR 串行空等。各 PR 写各自的文件，无竞争。
          await Promise.all(
            toReview.map(async (pr) => {
              // AutoPilot 后台评审无 AbortController，但同样标记「执行中」——纯思考阶段也在 PR 列表项显示。
              markAgentRunning(pr.localId);
              try {
                const session = await runReviewForPr(pr, agentContext, chat, undefined, true);
                // done：落「评审总结」消息 + 台账（含 verdict）+ 广播会话变更（与手动评审一致）。
                // 失败 / 暂停不落台账 → 无产出，下轮可重试（准入闸 2 用 hasReviewOutput 判，不再靠台账拦）。
                await recordReviewSummaryMessage(pr, session);
              } finally {
                unmarkAgentRunning(pr.localId);
              }
            }),
          );
        });
        logger.info({ candidates: candidates.length }, 'autopilot pass done');
      } catch (err) {
        logger.warn({ err }, 'autopilot pass failed (ignored)');
      } finally {
        autopilotBusy = false;
      }
    })();
  };

  return { runReview, runPlanning, stop, runAutopilotIfDue, terminateAgentsForGonePrs };
}
