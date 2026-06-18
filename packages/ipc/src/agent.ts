import type {
  AgentMessage,
  AgentRecommendationVerdict,
  AgentSession,
  AgentStep,
  ReviewRunTool,
} from '@meebox/shared';

/** Agent 交互域：规则匹配 / 评审编排 / 自由规划 / 会话与台账读取。 */
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
    request: { localId: string; question: string };
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
}
