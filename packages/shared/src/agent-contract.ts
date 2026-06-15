/**
 * 高阶 Agent 的会话与工具契约类型（见 docs/arch/06-agent.md「会话 Agent 化」与「数据契约」）。
 * 这些类型被**持久化**（@meebox/poller）、**经 IPC 传输**（ipc.ts）、并在渲染层呈现，
 * 故置于 shared（与 ReviewRun / Finding 同处）。@meebox/agent 的纯逻辑从此引用。
 */

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
  /** 步骤产生时间（ISO）。 */
  at?: string;
}

export type AgentRecommendationVerdict = 'approve' | 'needs_work' | 'manual_review';

/** 收尾建议（非约束性，不触发任何写操作，见「AutoPilot」）。 */
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
 * AutoPilot 每 PR 一条台账：去重 + 审计（见 docs/arch/06-agent.md「AutoPilot」）。
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
