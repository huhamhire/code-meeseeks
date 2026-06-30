import type {
  AgentMessage,
  AgentRecommendation,
  AgentStep,
  AgentTodoItem,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './prompts.js';
import type { MemoryNote } from './memory.js';
import { DEFAULT_STEP_LABELS, DEFAULT_SUMMARY_SECTIONS, type AgentStepLabels } from './orchestrator.js';
import { createStepRecorder } from './steps/context.js';
import {
  buildConversationContext,
  buildProtocol,
  planCycleStep,
  type PlanStepCtx,
} from './steps/planning/index.js';
import type { AgentContext } from './types.js';

/**
 * 自由规划（ReAct）编排器（见 docs/arch/02-agent/01-agent.md「会话 Agent 化」）：交互式入口的自然语言请求由它
 * 处理——驱动反复跑 plan-cycle 步骤（每轮 chat 规划下一动作、调工具 / 收尾），到 final 或步数上限。与固定
 * 微流程（runReviewMicroflow）互补。本文件只留**公共类型 + 驱动**，单步逻辑见 steps/planning。
 *
 * 纯逻辑：chat / runTool 注入；红线经 assertToolAllowed 落地（在 plan-cycle 步骤里）。
 */

export interface PlanningToolResult {
  text: string;
  usage?: TokenUsage;
}

export interface PlanningDeps {
  /** 规划 LLM 调用（单 system + user）。 */
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  /** 分发一个工具，返回文本结果（红线已由编排器先行校验）。 */
  runTool: (call: { tool: string; question?: string }) => Promise<PlanningToolResult>;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** 用户暂停信号；abort 后循环在下一步前停下，返回 terminationReason='aborted'（稳定 code，主进程映射本地化）。 */
  signal?: AbortSignal;
  /**
   * 取出运行期间排队的用户新消息（中途输入转向）：每轮顶部调用，非空则并入当轮 progress，让 ReAct 据
   * 最新指令与当前进度重排下一步。返回的消息由实现方（主进程）负责持久化到会话（此处只注入、不再落盘）。
   */
  drainPendingInput?: () => Promise<string[]> | string[];
  /**
   * 计划（todo）更新回调：模型每轮给出 / 更新 plan 时调用，由实现方持久化（session.todo）+ 广播刷新。
   * 计划随轮回喂提示、收到新输入时重排——见 buildProtocol 的 plan 约定。
   */
  recordPlan?: (todo: AgentTodoItem[]) => void | Promise<void>;
}

export interface PlanningInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  /** 命中规则的已拼接正文（多条经 combineRuleInstructions 拼成）；无命中传空 / null。 */
  matchedRuleInstructions?: string | null;
  language?: string;
  /** 步骤展示文案（主进程 i18n 解析后注入）；省略回落 DEFAULT_STEP_LABELS（en-US）。 */
  labels?: AgentStepLabels;
  /** 评审收尾骨架三段标题（主进程 i18n 注入 buildProtocol）；省略回落 DEFAULT_SUMMARY_SECTIONS（en-US）。 */
  summarySections?: readonly [string, string, string];
  /** 用户的自然语言请求。 */
  userRequest: string;
  /**
   * 既往多轮对话（用户 / 助手消息，按时间升序，不含本轮请求）。注入规划 LLM 的上下文，使
   * Agent 跨轮记住此前交流；**绝不**透传给 pr-agent 工具（工具只看 PR + 当轮问题）。
   */
  history?: AgentMessage[];
  /**
   * 用户在 Diff 里选中的代码引用（自描述块）。注入当轮规划上下文，让 Agent 知道用户正盯着哪段代码；
   * **绝不**透传给 pr-agent 工具（同 history 约束）。省略 = 本轮无选区引用。
   */
  referencedContext?: string;
  /** 步数上限（默认 8）。 */
  maxSteps?: number;
}

export interface PlanningResult {
  steps: AgentStep[];
  finalText: string;
  tokenUsage: TokenUsage;
  /** 收尾建议（仅评审类请求；非约束性）。供 UI 展示判定徽标，与 AutoPilot / 微流程一致。 */
  recommendation?: AgentRecommendation;
  /** 本轮主动记下、待持久化到各可写文件的非隐私条目（去重后写盘由上层处理）。 */
  memories: AgentMemoryNotes;
  /** 中止原因的稳定 code：'aborted'（用户暂停）/ 'max_steps'（步数上限）；本地化文案由主进程映射。 */
  terminationReason?: string;
}

/** Agent 主动记忆，按目标可写文件分组（键与 WritableAgentFile 对齐），各条带目标专题章节。 */
export interface AgentMemoryNotes {
  user: MemoryNote[];
  memory: MemoryNote[];
  agents: MemoryNote[];
}

function emptyMemoryNotes(): AgentMemoryNotes {
  return { user: [], memory: [], agents: [] };
}

/**
 * 驱动：现读现装配 system（含 Protocol）+ 会话上下文，反复跑 plan-cycle 步骤直至收尾 / 暂停 / 步数上限。
 * 单步逻辑（拼 prompt / 解析动作 / 红线 / 派发工具 / 中途输入 / 计划维护）见 steps/planning 的 planCycleStep。
 */
export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const rec = createStepRecorder(deps.onStep);
  const history: string[] = [];
  const memories = emptyMemoryNotes();
  const labels = input.labels ?? DEFAULT_STEP_LABELS;

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRuleInstructions: input.matchedRuleInstructions,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${buildProtocol(input.summarySections ?? DEFAULT_SUMMARY_SECTIONS)}`;

  // 既往多轮对话注入规划上下文（按预算裁剪），让 Agent 跨轮记住交流；仅供规划 LLM 参考，
  // 绝不透传给 pr-agent 工具。
  const convo = buildConversationContext(input.history ?? []);
  const ctx: PlanStepCtx = { deps, input, rec, system, convo, labels, history, memories, plan: [] };

  // 规划是单步循环：重复跑 plan-cycle 直至收尾 / 暂停 / 步数上限。
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await planCycleStep.run(ctx);
    if (outcome.kind === 'aborted') {
      return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: 'aborted' };
    }
    if (outcome.kind === 'final') {
      return {
        steps: rec.steps,
        finalText: outcome.finalText,
        tokenUsage: rec.usage,
        recommendation: outcome.recommendation,
        memories,
      };
    }
  }

  return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: 'max_steps' };
}
