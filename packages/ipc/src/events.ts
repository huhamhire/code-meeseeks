import type {
  AgentStep,
  AgentTodoItem,
  PollResult,
  SyncProgressEvent,
  UpdateCheckResult,
} from '@meebox/shared';
import type { PragentRunInfo } from './common.js';

/** Poller tick 完成后广播给 renderer 用于更新"最近一次同步"显示。 */
export interface PollTickEvent {
  /** tick 完成时间 ISO */
  at: string;
  result: PollResult;
}

/**
 * pr-agent run 期间 stdout / stderr 整行流式推送。renderer 拿来在 ChatPane
 * 或日志区域实时显示。一次 run 多条；run 结束后不再发。
 */
export interface PragentRunProgressEvent {
  runId: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

/** main → renderer 推送事件。renderer 用 window.api.subscribe 监听。 */
export interface IpcEvents {
  'sync:progress': SyncProgressEvent;
  'poll:tick': PollTickEvent;
  'pragent:runProgress': PragentRunProgressEvent;
  /**
   * 草稿变更广播：某 PR 的 drafts.json 发生增/删/改 / /review 完成时的"再摄入"
   * 清理都触发。renderer 据此重拉 drafts 列表 (per localId 过滤)。
   */
  'drafts:changed': { localId: string };
  /** finding 关闭关系变更广播：复评 /ask 取代/撤销原 finding（或撤销关闭）后触发，renderer 重拉关闭关系。 */
  'findingClosures:changed': { localId: string };
  /** 评论 reply / 状态变更后广播，renderer 各组件 (CommentsPanel / DiffView inline) 重拉 */
  'comments:changed': { localId: string };
  /**
   * 队列变化广播：active 增删 / waiting 增删都触发。renderer 据此同步 chat-pane
   * 运行中 UI + StatusBar 队列 chip。`active` 是当前并发运行中的 run 列表
   * （长度 ≤ max_concurrency）。
   */
  'pragent:queueChanged': {
    active: PragentRunInfo[];
    waiting: PragentRunInfo[];
  };
  /** 启动检测到新版本时推送（仅 hasUpdate=true 时发），renderer 据此提示。 */
  'app:updateAvailable': UpdateCheckResult;
  /** Agent 编排步骤流式推送：每产生一个 AgentStep 即发，renderer 据此实时呈现。 */
  'agent:stepProgress': { sessionId: string; prLocalId: string; step: AgentStep };
  /**
   * 某 PR 的多轮对话有新落盘消息（如后台 AutoPilot 评审收尾追加的「评审总结」）。renderer 若正打开
   * 该 PR 则据此重载会话，让后台产生的总结卡片即时出现（手动评审走 invoke 返回后自行重载，不依赖此事件）。
   */
  'agent:conversationChanged': { prLocalId: string };
  /**
   * 规划 Agent 的「计划（todo）」更新时推送：每当模型给出 / 更新计划即发，renderer 据此实时刷新计划面板。
   * 计划随会话持久化（session.todo），切 PR / 重启后经 agent:getSession 水合。
   */
  'agent:planUpdated': { prLocalId: string; todo: AgentTodoItem[] };
  /**
   * 运行中（思考或派发工具）的编排 Agent 所属 PR 集合变化时推送：手动 `agent:run` / `agent:ask`
   * 与 AutoPilot 后台评审一并计入。renderer 据此在 PR 列表项显示「执行中」指示——覆盖**纯思考阶段**
   * （无活跃工具 run 时），补齐仅看运行队列时思考态缺失执行中标记的空档。
   */
  'agent:runningChanged': { prLocalIds: string[] };
  /**
   * 某 PR 的评审状态被清除（清空执行历史时一并清掉 AutoPilot 台账）。renderer 据此即时清掉 PR 列表
   * 该 PR 的评审建议 ★ 徽标，避免清空后仍残留陈旧评审状态（不必等下个 poll 重取台账）。
   */
  'agent:reviewStatusCleared': { prLocalId: string };
}

export type IpcEventName = keyof IpcEvents;
