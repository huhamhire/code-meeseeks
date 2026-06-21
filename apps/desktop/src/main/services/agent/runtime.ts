import type { AgentSession, AgentStep, StoredPullRequest, TokenUsage } from '@meebox/shared';
import type { ServiceContext } from '../context.js';
import type { RunQueue } from '../pr-agent/index.js';

/** 共享 chat 通道：system + user → 文本 + usage。agent:run 评审与 AutoPilot 都用。 */
export type AgentChat = (input: {
  system: string;
  user: string;
  /** 输出 token 上限（轻量路由判读封顶用，见 ChatRunOptions.maxOutputTokens）。 */
  maxOutputTokens?: number;
}) => Promise<{ text: string; usage?: TokenUsage }>;

/**
 * 编排运行时：有状态协调器（Orchestrator）暴露给各 flow（review / planning / autopilot）的状态访问 +
 * 共享 helper 面。flow 以自由函数形式按「一任务一文件」拆分，经此 runtime 复用协调器的运行态与公共能力，
 * 而不各自持有可变状态。Orchestrator 实现本接口、把 `this` 作为 runtime 传入各 flow。
 */
export interface OrchestratorRuntime {
  readonly ctx: ServiceContext;
  readonly runQueue: RunQueue;
  /** 注册某 PR 的 AbortController（停止按钮 agent:stop 用）。 */
  registerController(localId: string, ac: AbortController): void;
  /** 清除某 PR 的 AbortController（收尾）。 */
  clearController(localId: string): void;
  /** 标记某 PR「执行中」并广播（纯思考阶段也显示）。 */
  markRunning(localId: string): void;
  /** 取消某 PR「执行中」标记并广播。 */
  unmarkRunning(localId: string): void;
  /** 步骤统一出口：后台日志 + agent:stepProgress 广播。 */
  emitStep(pr: StoredPullRequest, sessionId: string, step: AgentStep): void;
  /** 取出并清空某 PR 的待处理用户消息（中途输入转向）。 */
  takePending(localId: string): string[];
  /** 设置 LLM env + 临时 chat cwd + chat 函数后运行 fn，收尾清理临时目录。 */
  withAgentChat<T>(fn: (chat: AgentChat) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** 评审收尾统一落地：成功且有总结时追加 assistant 总结消息 + 写台账 + 广播会话变更。 */
  recordReviewSummaryMessage(pr: StoredPullRequest, session: AgentSession): Promise<void>;
  /** AutoPilot 单并发 busy 锁置位 / 复位。 */
  setAutopilotBusy(busy: boolean): void;
}
