import type { Logger } from 'pino';
import { scaffoldAgentDir } from '@meebox/agent';
import type { BootstrapResult } from '@meebox/config';
import type { PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PrAgentStatus } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import type { Orchestrator } from './agent/index.js';
import { broadcast } from './broadcast.js';
import { PrService } from './pr-service.js';
import type { RunQueue } from './pr-agent/index.js';

/** External dependencies of registerIpcHandlers (injected by main/index.ts). */
export interface RegisterDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
  /** Lazily get pr-agent probe status: probing runs async (does not block window creation); await for the final result */
  getPrAgentStatus: () => Promise<PrAgentStatus>;
  /** Lazily get the bridge instance; null when probing is unfinished / unavailable (neither embedded nor CLI) */
  getPrAgentBridge: () => PrAgentBridge | null;
  /** Embedded runtime interpreter path (used to patch .secrets.toml at execution time under the embedded strategy); may be empty for non-embedded */
  embeddedPythonPath?: string;
  stateStore: JsonFileStateStore;
  /** Archived PR cold storage (archived/ root, sibling of state/): read for the "closed" view list + when opening an archived PR's details. */
  archiveStore: JsonFileStateStore;
  poller: Poller;
  /** Mutable connection runtime (full adapters + adapterByHost); replaced in place by reconfigure after connections change in the settings page */
  connectionRuntime: ConnectionRuntime;
  /** Rebuild adapters/poller so connection changes take effect hot (called after config:setConnections is written to disk) */
  reconfigureConnections: () => Promise<void>;
  repoMirror: RepoMirrorManager;
  /** Rebuild the local API listener so service config (toggle / host / port) changes take effect hot (called after config:setService is written to disk). */
  reconfigureApiServer: () => Promise<void>;
}

/**
 * Runtime context shared by all services: external dependencies + cross-cutting utilities (broadcast / Agent dir) + PR domain service.
 * On top of this, cross-cutting services (run queue / Agent orchestration) are composed by ipc.ts into ControllerContext, avoiding a construction cycle.
 */
export interface ServiceContext extends RegisterDeps {
  /** Broadcast main → renderer events to all windows (strongly typed by IpcEvents). */
  broadcast: typeof broadcast;
  /** The effective Agent dir: user config takes precedence, falling back to the default location (~/.code-meeseeks/agent) when unset. */
  effectiveAgentDir(): string;
  /**
   * Get the effective Agent dir, **idempotently backfill** the context templates (SOUL/AGENTS/MEMORY/USER + rules/), then return its path.
   * "Initialize on use": same approach as read-and-assemble-on-demand — regardless of whether the dir comes from the startup default / in-app hot switch / a restart after directly editing the config file,
   * always ensure it is initialized before each load, not relying on one-off moments like first launch or settings interaction. Idempotent (does not overwrite if present); on failure only warns,
   * does not throw (loadAgentContext / loadAgentRules still degrade per missing files).
   */
  ensureAgentDir(): Promise<string>;
  /** PR domain service: PR lookup / adapter / mirror / diff base / comments cache. */
  pr: PrService;
}

/**
 * Unified controller-layer context: on top of ServiceContext, attach two more cross-cutting services (run queue / Agent orchestration),
 * so all controllers share the same `ctx` input to access every capability, with a uniform `(ctx, req, evt)` signature.
 * The two cross-cutting services are built from the base ServiceContext (see ipc.ts assembly order), and this context is composed once they are built.
 */
export interface ControllerContext extends ServiceContext {
  runQueue: RunQueue;
  orchestrator: Orchestrator;
}

export function createServiceContext(deps: RegisterDeps): ServiceContext {
  const effectiveAgentDir = (): string =>
    deps.bootstrap.config.agent.dir || deps.bootstrap.paths.agentDir;
  return {
    ...deps,
    broadcast,
    effectiveAgentDir,
    ensureAgentDir: async () => {
      const dir = effectiveAgentDir();
      try {
        const created = await scaffoldAgentDir(dir);
        if (created.length) deps.logger.info({ agentDir: dir, created }, 'agent dir scaffolded');
      } catch (err) {
        deps.logger.warn({ err, agentDir: dir }, 'ensure agent dir scaffold failed');
      }
      return dir;
    },
    pr: new PrService({
      bootstrap: deps.bootstrap,
      stateStore: deps.stateStore,
      archiveStore: deps.archiveStore,
      connectionRuntime: deps.connectionRuntime,
      repoMirror: deps.repoMirror,
    }),
  };
}

// === process-level singleton context of the controller layer ===
// At startup registerIpcHandlers composes a ControllerContext once (base + runQueue + orchestrator) and installs it;
// controllers access it via getContext(), so handler signatures return to the standard ipcMain.handle form (req, evt) without ctx.
// Single source of truth, lives for the process lifecycle; tests can setControllerContext(mock) first then call the controller.
let currentContext: ControllerContext | undefined;

/** Called by registerIpcHandlers after assembly completes, to install the process-level controller context singleton. */
export function setControllerContext(ctx: ControllerContext): void {
  currentContext = ctx;
}

/** Get the controller context singleton; throws if uninitialized (before registerIpcHandlers / during module load) to guard timing. */
export function getContext(): ControllerContext {
  if (!currentContext) {
    throw new Error('ControllerContext 尚未初始化（registerIpcHandlers 未调用）');
  }
  return currentContext;
}
