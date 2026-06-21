import type {
  AgentMessage,
  AgentRecommendationVerdict,
  AgentSession,
  AgentStep,
  ReviewRun,
  ReviewRunTool,
} from '@meebox/shared';
import type { PragentRunInfo } from './common.js';

/** Agent 交互域：规则匹配 / 评审编排 / 自由规划 / 会话与台账 / pr-agent run 队列。 */
export interface AgentChannels {
  /**
   * 给指定 PR 查 `<agent.dir>/rules` 当前命中的规则 (按 priority desc + path asc 取首条)。
   * 调用方传 tool 区分 /describe / /review (规则可能只对其中一个 tool 生效)。
   * agent.dir 未配置 / 整体禁用 / 无命中 → 返回 null。
   */
  'rules:matchForPr': {
    request: { localId: string; tool: ReviewRunTool };
    response: {
      id: string;
      filePath: string;
      priority: number;
      tools: ReviewRunTool[];
      instructions: string;
    } | null;
  };
  /**
   * 对指定 PR 跑一次 Agent 评审微流程（describe→review→条件追问→总结）。同步等待，
   * 期间经 agent:stepProgress 推送步骤；返回收尾后的 AgentSession（含 summary /
   * recommendation）。pr-agent 不可用时 reject。
   */
  'agent:run': {
    request: { localId: string };
    response: AgentSession;
  };
  /**
   * 对指定 PR 跑自由规划 Agent（自然语言入口「对话即委派」）。同步等待，步骤经
   * agent:stepProgress 推送；返回收尾会话（summary = Agent 最终回答）。
   */
  'agent:ask': {
    /**
     * referencedContext：用户在 Diff 里选中的代码片段（含路径 + 行范围 + 代码），作为**隐式上下文**
     * 注入规划 LLM 的当轮提示，不进入持久化的用户消息正文。省略 = 本轮不带选区引用。
     */
    request: { localId: string; question: string; referencedContext?: string };
    response: AgentSession;
  };
  /** 暂停当前 PR 的 Agent 运行（abort）；会话置 paused、保态。 */
  'agent:stop': { request: { localId: string }; response: { ok: boolean } };
  /**
   * 读取指定 PR 已落盘的 Agent 会话（含收尾 summary / recommendation）；无则返回 null。
   * 供 UI 打开 PR 时恢复「评审总结」卡片——总结归属其发起 PR、跨 PR 切换不丢失、不串台。
   */
  'agent:getSession': { request: { localId: string }; response: AgentSession | null };
  /**
   * 读取指定 PR 的多轮对话消息（用户输入 + Agent 回答，按时间升序）；无则空数组。
   * UI 据此渲染多轮会话；跨 PR 切换 / 重启后恢复。
   */
  'agent:getConversation': { request: { localId: string }; response: AgentMessage[] };
  /**
   * 读取指定 PR 已落盘的 Agent 过程步骤（transcript，按时间升序）；无则空数组。
   * UI 据此恢复「过程化跟踪」的思考步骤——跨 PR 切换 / 重启后不丢失（步骤随产生增量落盘）。
   */
  'agent:getTranscript': { request: { localId: string }; response: AgentStep[] };
  /**
   * 批量读 AutoPilot 台账：返回各 PR 已自动评审的 recommendation（仅 decision=review 且有
   * 建议者）。PR 列表据此显示徽标，无需逐个加载会话。
   */
  'agent:autopilotLedgers': {
    request: { localIds: string[] };
    response: Record<string, AgentRecommendationVerdict>;
  };
  // ── pr-agent run 队列（评审工具执行层；agent:run / AutoPilot 与用户手动 run 共用同一队列）──
  /**
   * 触发一次 pr-agent /describe 或 /review。同步等待执行结束（可能数十秒到数分钟），
   * 期间通过 pragent:runProgress 事件推送 stdout / stderr 行。返回最终 ReviewRun
   * 状态 (succeeded / failed)。pr-agent 不可用时 reject。
   */
  'pragent:run': {
    /**
     * tool='ask' 时 question 必填，作为 pr-agent CLI 的位置参数传给 ask 子命令。
     * tool='describe'/'review' 时 question 字段被忽略。
     * referencedContext：用户在 Diff 里选中的代码片段（隐式上下文），仅 tool='ask' 时生效——经
     * EXTRA_INSTRUCTIONS 注入，不进入问题位置参数（故不污染回答 echo / 会话气泡）。
     */
    request: {
      localId: string;
      tool: ReviewRunTool;
      question?: string;
      referencedContext?: string;
    };
    response: ReviewRun;
  };
  /**
   * 列出某 PR 的历史 run，newest first。支持时间戳游标分页：
   * - limit：截到 N 条；省略 = 不限（renderer 端慎用，规模大时可能慢）
   * - beforeId：游标，返回 runId **严格小于** 此值的条目；省略 = 不限上界
   *
   * runId 是时序字典序 (`yyyymmdd-HHmmss-mmm`)，"取游标后 N 条" 即"取此时刻之前的 N 条"
   */
  'pragent:listRuns': {
    request: { localId: string; limit?: number; beforeId?: string };
    response: ReviewRun[];
  };
  /** 单条 run 查询（用于 renderer 在事件断流后兜底刷新） */
  'pragent:getRun': {
    request: { localId: string; runId: string };
    response: ReviewRun | null;
  };
  /** 清空指定 PR 的全部 run 历史记录（仅该 PR 生效）。返回删除条数。 */
  'pragent:clearRuns': {
    request: { localId: string };
    response: { cleared: number };
  };
  /**
   * 取消一个 run。语义跟 run 当前状态相关：
   * - 跟 active 匹配 → SIGKILL 子进程，落盘 status='cancelled'
   * - 在 waiting 队列里 → 从队列删除，**不**写盘 (从未真正跑过)；触发 pragent:run
   *   原调用方的 Promise reject 让 ChatPane handleRun 走 error 分支
   * - 都不匹配 (已结束 / 不存在) → 静默 no-op (返回 ok:false)
   */
  'pragent:cancel': {
    request: { runId: string };
    response: { ok: boolean };
  };
  /**
   * 查询当前队列快照 (active + waiting)；renderer 启动 / 重连时拉一下，
   * 跟 queueChanged 事件配套兜底。
   */
  'pragent:queue': {
    request: void;
    response: { active: PragentRunInfo[]; waiting: PragentRunInfo[] };
  };
}
