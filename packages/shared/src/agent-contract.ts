/**
 * 高阶 Agent 的会话与工具契约类型（见 docs/arch/02-agent/02-session.md「会话 Agent 化」与「数据契约」）。
 * 这些类型被**持久化**（@meebox/poller）、**经 IPC 传输**（ipc.ts）、并在渲染层呈现，
 * 故置于 shared（与 ReviewRun / Finding 同处）。@meebox/agent 的纯逻辑从此引用。
 */

import type { TokenUsage } from './poller-contract.js';

/** 工具的副作用分类与可用性（红线落地的依据，见「工具修改红线」）。 */
export interface ToolCatalogEntry {
  /** 工具指令名，如 `/describe`。 */
  name: string;
  /** 语义说明，注入提示词供 Agent 理解何时调用。 */
  summary: string;
  /** 是否修改类（对远端有副作用）。读/分析类 = false。 */
  mutating: boolean;
  /** 是否可被 Agent 自主调用：修改类在未授权时为 false（禁用态注入）。 */
  enabled: boolean;
}

export type AgentSessionStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

/** 编排步骤的种类：规划 / 工具分发 / 判读（见「步与子任务的计量边界」）。 */
export type AgentStepKind = 'plan' | 'tool' | 'judge';

export interface AgentTodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface AgentToolCall {
  /** 被分发的工具名（如 `/review`）。 */
  tool: string;
  args?: Record<string, unknown>;
}

/** 一个编排级步骤（编排 agent 的一次决策回合，不含 pr-agent run 内部开销）。 */
export interface AgentStep {
  kind: AgentStepKind;
  /** 思考摘要（留档 + 流式推送）。 */
  thought?: string;
  /** kind='tool' 时的工具调用。 */
  toolCall?: AgentToolCall;
  /** 工具结果 / 判读结论的摘要。 */
  result?: string;
  /** 本步**单独**的 LLM token 用量（不累计、不含其它步）：judge / 总结 / 规划等经独立通道的推理步在此带值；
   *  describe/review/ask 的工具开销由其各自 run 卡片承载、不在步骤上重复计。UI 在步骤行展示，使每步成本可见。 */
  usage?: TokenUsage;
  /** 步骤产生时间（ISO）。 */
  at?: string;
  /** 本步思考（产生该决策的单次 LLM 推理）耗时（毫秒）；类 Claude Code 的「Thought for Ns」单步计时。
   *  仅推理类步骤（plan/judge）有值；固定派发（如微流程的 describe/review 选择）无 LLM 思考则缺省。 */
  thinkMs?: number;
  /** 是否 AutoPilot 后台评审触发：仅标在该次评审的首步上，UI 据此在步骤行打机器人 chip。 */
  autopilot?: boolean;
}

export type AgentRecommendationVerdict = 'approve' | 'needs_work' | 'manual_review';

/** 收尾建议（非约束性，不触发任何写操作，见「AutoPilot」）。 */
export interface AgentRecommendation {
  verdict: AgentRecommendationVerdict;
  reason: string;
}

export type AgentMessageRole = 'user' | 'assistant';

/**
 * 一条对话消息（回合级，区别于回合内的 AgentStep）。多轮对话的持久化单元：用户输入与 Agent
 * 收尾回答各一条，按时间追加。Agent 自身上下文（规划）会读取历史消息，但**绝不**注入 pr-agent
 * 工具调用（工具只看 PR + 当轮问题）。
 */
export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  /** assistant 评审类回合的非约束性判定；对话 / 用户消息不填。 */
  recommendation?: AgentRecommendation;
  /**
   * 用户消息携带的引用上下文（自描述 markdown：路径 + 行范围 + 代码围栏，见
   * renderer formatReferencedContext）。发起提问时若带 Diff 选区则填，UI 在气泡下方折叠展示；
   * 无选区 / 助手消息不填。（finding 引用走 /ask run 卡片，不经本字段。）
   */
  referencedContext?: string;
  /** 产生时间（ISO），用于时间线排序。 */
  at: string;
}

/** 持久化包装：`prs/<localId>/agent/conversation.json`（多轮消息流式追加，跨回合保留）。 */
export interface AgentConversationFile {
  schema_version: 1;
  messages: AgentMessage[];
}

/** 每个 PR 一份、由子 agent 所有的会话记录（见数据契约）。 */
export interface AgentSession {
  id: string;
  prLocalId: string;
  status: AgentSessionStatus;
  todo: AgentTodoItem[];
  stepCount: number;
  maxSteps: number;
  /**
   * 触发本会话的用户自然语言请求（「对话即委派」入口 agent:ask）。自动评审（agent:run）
   * 无文本输入 → 不填。UI 据此把用户输入回显为右对齐气泡、归属其发起 PR、持久化恢复。
   */
  userRequest?: string;
  /** 本 PR 收尾总结正文（summary_max_chars 仅作提示词软约束引导篇幅，不对正文硬截断）。 */
  summary?: string;
  /** 收尾建议（非约束性）。 */
  recommendation?: AgentRecommendation;
  startedAt: string;
  finishedAt?: string;
  /** 终止原因（如「步数上限中止」「用户暂停」）。 */
  terminationReason?: string;
}

/** 持久化包装：`prs/<localId>/agent/session.json`。 */
export interface AgentSessionFile {
  schema_version: 1;
  session: AgentSession;
}

/** 持久化包装：`prs/<localId>/agent/transcript.json`（步骤流式追加）。 */
export interface AgentTranscriptFile {
  schema_version: 1;
  steps: AgentStep[];
}

export type AutopilotDecision = 'review' | 'skipped';

/**
 * AutoPilot 每 PR 一条台账：去重 + 审计（见 docs/arch/02-agent/03-autopilot.md「AutoPilot」）。
 * 是否「未自动评审过当前版本」据 `autoReviewedUpdatedAt` 与当前 PR `updatedAt` 是否一致判定，
 * 故 PR 推新 commit 后能再次进入候选、内容未变则不重复跑。
 */
export interface AutopilotLedger {
  prLocalId: string;
  /** 评审 / 判定时所对应的 PR updatedAt 快照。 */
  autoReviewedUpdatedAt: string;
  decision: AutopilotDecision;
  /** 判定原因（skipped 时尤其有用，便于审计 / UI 展示）。 */
  reason?: string;
  /** 若评审，子 agent 给出的建议倾向（供 PR 列表徽标直接读、无需加载会话）。 */
  recommendation?: AgentRecommendationVerdict;
  /** 写入时间（ISO）。 */
  at: string;
}

/** 持久化包装：`prs/<localId>/agent/autopilot.json`。 */
export interface AutopilotLedgerFile {
  schema_version: 1;
  ledger: AutopilotLedger;
}
