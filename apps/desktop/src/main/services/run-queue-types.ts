import type { PragentRunInfo } from '@meebox/ipc';
import type { ReviewRun, ReviewRunTool, StoredPullRequest } from '@meebox/shared';

/** pr-agent run 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。 */
export type RunPriority = 'user' | 'agent';

/** 队列项：一次入队的 pr-agent run 的全部上下文（含 resolve/reject 回原始调用方）。 */
export interface QueueItem {
  info: PragentRunInfo;
  req: { localId: string; tool: ReviewRunTool; question?: string; referencedContext?: string };
  pr: StoredPullRequest;
  resolve: (run: ReviewRun) => void;
  reject: (err: Error) => void;
  /** 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。 */
  priority: RunPriority;
  /** 仅 active 状态填；用于 cancel SIGKILL */
  ac?: AbortController;
}
