/**
 * pr-agent run 子系统：调度（RunQueue：并发 / 优先级 / 取消）+ 执行（RunExecutor，内部协作件，不外暴露）。
 * 对外只暴露 RunQueue 与队列相关类型。
 */
export { RunQueue } from './run-queue.js';
export type { QueueItem, RunPriority } from './run-queue.js';
