/**
 * 应用启动装配域：进程/平台微调 + 各运行时（pr-agent / 连接 / 窗口 / 轮询 / 镜像 / 版本检测）的 init/factory。
 * index.ts 作为组合根从此处取用、装配；各模块只依赖 ../（context / services / utils / adapters）与库包。
 */
export { applyProcessStartupTweaks } from './process-tweaks.js';
export { PrAgentRuntime } from './pragent-runtime.js';
export { ConnectionRuntimeController } from './connections-runtime.js';
export { createPoller } from './poller.js';
export { createRepoMirror } from './repo-mirror.js';
export { WindowManager, loadWindowManager } from './window.js';
export { UpdateRunner } from './update-runner.js';
