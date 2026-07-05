/**
 * Application startup assembly domain: OS/platform startup tweaks + init/factory for each runtime
 * (pr-agent / connections / window / poller / mirror / version detection / splash). index.ts acts as
 * the composition root that draws from here and assembles; each module only depends on ../ (context /
 * services / utils / adapters) and library packages.
 */
export { applyOsStartupTweaks } from './os-startup-tweaks.js';
export { PrAgentRuntime } from './pragent-runtime.js';
export { ConnectionRuntimeController } from './connections-runtime.js';
export { createPoller } from './poller.js';
export { createRepoMirror } from './repo-mirror.js';
export { WindowManager, loadWindowManager } from './window-manager.js';
export { createSplash } from './splash.js';
export { Updater } from './updater.js';
