import { createAgentOrchestratorService } from './services/agent-orchestrator.js';
import { registerAgentHandlers } from './services/agent/index.js';
import { registerAppHandlers } from './services/app/index.js';
import { registerConfigHandlers } from './services/config/index.js';
import { createIpcContext, type RegisterDeps } from './services/context.js';
import { registerPrHandlers } from './services/pr/index.js';
import { createRunQueueService } from './services/run-queue.js';

export type { RegisterDeps } from './services/context.js';

/**
 * 注册全部 IPC handler。薄入口：构建共享上下文 → 建两个跨域 service（run 队列 / Agent 编排）
 * → 按业务领域注册 handler（GUI 框架 / PR 操作 / 配置 / Agent 交互）→ 返回运行时控制句柄。
 *
 * 各域业务实现见 `services/`：app·pr·config·agent 各域 handler，run-queue / agent-orchestrator
 * 两个跨域 service，common/ 公共工具，context.ts 共享上下文。新增 channel 时先在 `@meebox/ipc`
 * 对应域加类型，再到对应 service 加 handler。
 */
export function registerIpcHandlers(deps: RegisterDeps): {
  abortAllActiveRuns: () => number;
  runAutopilotIfDue: () => void;
  terminateAgentsForGonePrs: () => void;
} {
  const ctx = createIpcContext(deps);
  // run 队列：pragent:run（PR 域）、Agent 编排、AutoPilot 三方共用。
  const runQueue = createRunQueueService(ctx);
  // Agent 编排：复用 run 队列派发工具 run（agent 低优先级泳道）。
  const orchestrator = createAgentOrchestratorService(ctx, runQueue);

  registerAppHandlers(ctx);
  registerPrHandlers(ctx, runQueue);
  registerConfigHandlers(ctx);
  registerAgentHandlers(ctx, orchestrator);

  ctx.logger.debug('IPC handlers registered');

  return {
    /**
     * 应用退出时调用：中止所有进行中的 run。每个 run 的 AbortController.abort() 会触发 exec 的
     * onAbort → killTree（进程树级杀），连带终止 python 及其 litellm 等孙进程，避免孤儿进程锁住
     * 安装目录导致升级安装失败。返回被中止的 run 数，供调用方决定是否需要短暂等待 taskkill 跑完。
     */
    abortAllActiveRuns: () => runQueue.abortAllActiveRuns(),
    /** 每次 poll tick 由 index.ts 调用：满足开关 + 候选时跑一遍 AutoPilot pass。 */
    runAutopilotIfDue: () => orchestrator.runAutopilotIfDue(),
    /** 每次 poll tick 由 index.ts 调用：终止已被移除 / purge 的 PR 上仍在执行的 agent 操作。 */
    terminateAgentsForGonePrs: () => void orchestrator.terminateAgentsForGonePrs(),
  };
}
