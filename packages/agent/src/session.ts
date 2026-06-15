/**
 * Agent 会话与工具目录的领域类型（见 docs/arch/06-agent.md §3 / 数据契约）。
 * 纯类型 + 不依赖运行时；编排器、持久化、IPC 后续接入。
 */

/** 工具的副作用分类与可用性（红线落地的依据，见 §4）。 */
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

/** 编排步骤的种类：规划 / 工具分发 / 判读（见 §3 计量边界）。 */
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
}

export type AgentRecommendationVerdict = 'approve' | 'needs_work' | 'manual_review';

/** 收尾建议（非约束性，不触发任何写操作，见 §6）。 */
export interface AgentRecommendation {
  verdict: AgentRecommendationVerdict;
  reason: string;
}

/** 每个 PR 一份、由子 agent 所有的会话记录（见数据契约）。 */
export interface AgentSession {
  id: string;
  prLocalId: string;
  status: AgentSessionStatus;
  todo: AgentTodoItem[];
  stepCount: number;
  maxSteps: number;
  /** 本 PR 收尾总结正文（受 summary_max_chars 限长）。 */
  summary?: string;
  /** 收尾建议（非约束性）。 */
  recommendation?: AgentRecommendation;
  startedAt: string;
  finishedAt?: string;
  /** 终止原因（如「步数上限中止」「用户暂停」）。 */
  terminationReason?: string;
}
