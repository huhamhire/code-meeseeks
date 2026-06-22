import { runReviewMicroflow, type AgentContext, type ReviewPlan } from '@meebox/agent';
import { appendAgentStep, startAgentSession, updateAgentSession } from '@meebox/poller';
import type { Rule } from '@meebox/rules';
import type {
  AgentSession,
  AgentStep,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import { buildStepLabels, buildSummarySections, mapTerminationReason } from './labels.js';

/**
 * 把纯逻辑的 `runReviewMicroflow` 接到主进程能力上（见 docs/arch/06-agent.md
 * 「AutoPilot」有界微流程）：
 * - runTool：经既有 pr-agent 运行队列跑 describe/review/ask，取产物文本回喂；
 * - chat：经嵌入式运行时的独立 LLM 通道做受限判断 / 总结；
 * - 持久化 + 步骤流式：startAgentSession / appendAgentStep / updateAgentSession + onStep 广播。
 */

const STDOUT_LOG_SEP = '\n\n---\n[pr-agent stdout log]\n';

/** 取一次 run 的「LLM 真实产出」（剥掉 ipc 拼在后面的 pr-agent stdout 日志段）。 */
function reviewRunText(run: ReviewRun): string {
  return (run.stdout ?? '').split(STDOUT_LOG_SEP)[0]?.trim() ?? '';
}

export interface ReviewDeps {
  stateStore: StateStore;
  /** 入队一个 pr-agent run，resolve 完成的 ReviewRun（与用户手动 run 共用队列）。 */
  enqueueRun: (pr: StoredPullRequest, tool: ReviewRunTool, question?: string) => Promise<ReviewRun>;
  /** 经独立 LLM 通道做一次受限对话（判严重性 / 出总结）。 */
  chat: (input: { system: string; user: string }) => Promise<{ text: string; usage?: TokenUsage }>;
  agentContext: AgentContext;
  matchedRule?: Rule | null;
  language: string;
  /** 工具目录（含修改红线标注）；注入编排器系统上下文。 */
  toolCatalog?: ToolCatalogEntry[];
  maxFollowupAsks: number;
  summaryMaxChars: number;
  /** 评审执行计划（步骤序列）；省略 / 非法时微流程回落默认全集。仅 AutoPilot 按规则注入，手动评审省略。 */
  plan?: ReviewPlan;
  /** 步骤流式回调（广播给渲染层）。 */
  onStep?: (sessionId: string, step: AgentStep) => void;
  /** 用户停止：透传给微流程，思考 / 执行任意阶段都能立即中止（停止按钮 → agent:stop）。 */
  signal?: AbortSignal;
  /** 是否 AutoPilot 后台派发：标到本次评审的**首步**上，UI 据此在步骤行打机器人 chip。 */
  autopilot?: boolean;
}

/**
 * 对一个 PR 跑评审微流程并落盘会话。返回收尾后的 AgentSession（成功 done / 失败 failed）。
 * 微流程内部工具失败会抛错，这里兜成 failed 会话而非向上抛（背景自动化不该崩主流程）。
 */
export async function runReview(
  pr: StoredPullRequest,
  deps: ReviewDeps,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  // 步数上限按微流程模板推导：describe + review + ≤N 追问 + 总结（+判定余量）。
  const session = await startAgentSession(
    deps.stateStore,
    { prLocalId: pr.localId, maxSteps: 3 + deps.maxFollowupAsks + 1 },
    now,
  );

  // AutoPilot 触发时，机器人标记只打在本次评审的**首步**上（首步即「生成 PR 描述与审查发现」）。
  let firstStep = true;
  try {
    const result = await runReviewMicroflow(
      {
        runTool: async ({ tool, question }) => {
          const run = await deps.enqueueRun(pr, tool, question);
          if (run.status !== 'succeeded') {
            throw new Error(`pr-agent ${tool} 未成功：${run.errorMessage ?? run.status}`);
          }
          return { text: reviewRunText(run), usage: run.tokenUsage };
        },
        chat: deps.chat,
        onStep: async (step) => {
          const tagged = deps.autopilot && firstStep ? { ...step, autopilot: true } : step;
          firstStep = false;
          await appendAgentStep(deps.stateStore, pr.localId, tagged, now);
          deps.onStep?.(session.id, tagged);
        },
        signal: deps.signal,
      },
      {
        context: deps.agentContext,
        pr: { title: pr.title, description: pr.description, targetBranch: pr.targetRef.displayId },
        matchedRule: deps.matchedRule,
        language: deps.language,
        labels: buildStepLabels(),
        summarySections: buildSummarySections(),
        toolCatalog: deps.toolCatalog,
        plan: deps.plan,
        maxFollowupAsks: deps.maxFollowupAsks,
        summaryMaxChars: deps.summaryMaxChars,
      },
    );

    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: 'done',
        summary: result.summary,
        recommendation: result.recommendation,
        finishedAt: now().toISOString(),
      })) ?? session
    );
  } catch (err) {
    // 用户停止（abort）→ 干净的 paused 收尾，不当失败报错；其余异常仍记为 failed。
    const aborted = deps.signal?.aborted || (err instanceof Error && err.message === 'aborted');
    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: aborted ? 'paused' : 'failed',
        finishedAt: now().toISOString(),
        terminationReason: aborted
          ? mapTerminationReason('aborted')
          : err instanceof Error
            ? err.message
            : String(err),
      })) ?? session
    );
  }
}
