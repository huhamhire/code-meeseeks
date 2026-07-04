import { app, BrowserWindow, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@meebox/config';
import { scaffoldAgentDir } from '@meebox/agent';
import { editorThemeNativeSource, resolveLanguage } from '@meebox/shared';
import { createLogger } from '@meebox/logger';
import { sweepOrphanedArchivedPrs, type Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import { JsonFileStateStore } from '@meebox/state-store';
import {
  ConnectionRuntimeController,
  PrAgentRuntime,
  Updater,
  type WindowManager,
  applyOsStartupTweaks,
  createPoller,
  createRepoMirror,
  createSplash,
  loadWindowManager,
} from './bootstrap/index.js';
import { initMainI18n } from './i18n/index.js';
import { registerIpcHandlers } from './ipc.js';
import { ApiServer } from './services/api-server/index.js';
import { readConnectionStates } from './utils/connection-state.js';

// Process (module load) start point: used to measure startup time to the main window's first frame (ready-to-show).
const PROCESS_START_MS = Date.now();

// Runtime control handle returned by registerIpcHandlers: on exit, used to abort all in-progress pr-agent runs
// (triggering their child process tree cleanup, see before-quit); the poll tick also does AutoPilot admission and
// cleanup of in-flight operations on PRs that have disappeared.
type IpcControl = {
  abortAllActiveRuns: () => number;
  runAutopilotIfDue: () => void;
  terminateAgentsForGonePrs: () => void;
  invalidateCommentsCache: (localId: string) => void;
};

/**
 * Application composition root: holds each subsystem instance (fields), initializes by domain (workspace/logging →
 * each runtime → connections/poller/IPC → window → start polling) and hooks into the app lifecycle. Single entry
 * main(): process tweaks → single-instance lock → new App().run(). Each runtime's construction/factory lives within
 * the bootstrap/ domain; this class only handles assembly and lifecycle orchestration.
 */
class App {
  private bootstrap!: BootstrapResult;
  private logger!: Logger;
  private stateStore!: JsonFileStateStore;
  /** Archived PR cold storage (`archived/` root, sibling of state/); exiting PRs are moved in as a whole tree, cleaned by grace period. */
  private archiveStore!: JsonFileStateStore;
  private poller!: Poller;
  private repoMirror!: RepoMirrorManager;
  private prAgent!: PrAgentRuntime;
  private updater!: Updater;
  private conns!: ConnectionRuntimeController;
  private windowManager!: WindowManager;
  private ipcControl?: IpcControl;
  /** Local API service listener (off by default; config.service decides whether to listen). */
  private apiServer?: ApiServer;
  private quitCleanupDone = false;

  constructor(private readonly startMs: number) {}

  /**
   * The single startup sequence: hook into the lifecycle → initialize by domain; if any stage throws, log fatal and exit.
   */
  async run(): Promise<void> {
    this.registerLifecycle();
    try {
      await this.bootstrapCore();
      this.initRuntimes();
      // Sweep atomic-write temp files left over from the last session (orphan tmp left when the process exited
      // between write↔rename). Swept early at startup, before any write, safe under the single-writer premise
      // (see JsonFileStateStore.sweepStaleTmpFiles).
      await this.stateStore
        .sweepStaleTmpFiles()
        .catch((err: unknown) => this.logger.warn({ err }, 'state-store: tmp sweep failed'));
      // Archive cold storage likewise sweeps atomic-write tmp left over from the last session (exiting mid-migration may leave orphans).
      await this.archiveStore
        .sweepStaleTmpFiles()
        .catch((err: unknown) => this.logger.warn({ err }, 'archive-store: tmp sweep failed'));
      // Archive orphan sweep: after the unified index is lost / rebuilt, archived data loses its index entries and the
      // index-driven hard cleanup can't reach it → permanent orphans. At startup (before any write), reclaim via an
      // index-less fallback keyed on "no index entry + directory mtime past grace" (see docs/arch/99-core/01-state-storage).
      await sweepOrphanedArchivedPrs({
        stateStore: this.stateStore,
        archiveStore: this.archiveStore,
        logger: this.logger,
      }).catch((err: unknown) => this.logger.warn({ err }, 'archive housekeeping: orphan sweep failed'));
      await this.initConnectionsAndIpc();
      await this.initWindow();
      await this.startPolling();
    } catch (e: unknown) {
      if (this.logger) this.logger.fatal({ err: e }, 'startup failed');
      else console.error('meebox startup failed:', e);
      app.quit();
    }
  }

  /**
   * ① Settle workspace + fix i18n + ready logging + scaffold Agent dir + macOS PATH completion + global fallback.
   */
  private async bootstrapCore(): Promise<void> {
    this.bootstrap = await ensureWorkspace();
    // Fix main process i18n (user-facing text such as dialog titles, error messages). When config.language is empty,
    // resolve by the OS preferred language and fall back to English if there's no match; the result is also reused for
    // the pr-agent response language, consistent with the UI.
    initMainI18n(
      resolveLanguage(this.bootstrap.config.language, app.getPreferredSystemLanguages()),
    );
    // pretty only on in non-packaged mode: dev console single-line + ISO8601 + colored; packaged mode keeps raw JSON.
    this.logger = await createLogger({
      logsDir: this.bootstrap.paths.logsDir,
      pretty: !app.isPackaged,
    });
    this.logger.info(
      { firstRun: this.bootstrap.firstRun, appDir: this.bootstrap.paths.appDir },
      'meebox main process started',
    );

    // Agent dir scaffold: fill in the template for the **effective directory** (user-configured agent.dir takes
    // priority, falls back to the default agent/ when unconfigured—same basis as ipc.ts effectiveAgentDir). Previously
    // the default directory was mistakenly used, so a configured custom directory wouldn't be initialized and startup
    // would load an empty directory. Idempotent (won't overwrite what exists), so context files like SOUL/AGENTS are
    // readable on first use. Failure doesn't block startup (at runtime loadAgentContext still degrades on missing files
    // + warns). For filling in after changing agent.dir, see config.setAgent.
    const agentDir = this.bootstrap.config.agent.dir || this.bootstrap.paths.agentDir;
    void scaffoldAgentDir(agentDir)
      .then((created) => {
        if (created.length) this.logger.info({ created }, 'agent dir scaffolded');
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'scaffold agent dir failed');
      });

    // Main process global fallback: leave at least one log for uncaught exceptions / unhandled rejections, no silent crash.
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error({ err: reason }, 'unhandledRejection');
    });
  }

  /**
   * ② pr-agent runtime (interpreter + kick-off probe) + version updater + state store.
   */
  private initRuntimes(): void {
    // pr-agent runtime: resolve embedded interpreter + kick-off probe (not awaited, doesn't block the window's first frame), result backfilled asynchronously.
    this.prAgent = new PrAgentRuntime(this.bootstrap, this.logger);
    // Version updater: runIfDue is called along with the poller tick (at most once per hour, reusing the poller cycle, no separate timer).
    this.updater = new Updater(this.bootstrap, this.logger);
    this.stateStore = new JsonFileStateStore(this.bootstrap.paths.stateDir, this.logger);
    this.archiveStore = new JsonFileStateStore(this.bootstrap.paths.archivedDir, this.logger);
  }

  /**
   * ③ Connection-level local state → poller → connection runtime (wiring) → repoMirror → IPC handlers.
   */
  private async initConnectionsAndIpc(): Promise<void> {
    // Load connection-level local state (including currentUser from the last ping). Missing (first run) / corrupt →
    // degrade to an empty table + warn; the only consequence is the first poll has no pre-warmed identity, which is
    // auto-reclassified once the async ping fills in currentUser, without loss of function (wiring / ping see connections-runtime).
    const connectionStates = await readConnectionStates(this.stateStore).catch((err: unknown) => {
      this.logger.warn(
        { err },
        'read connection states failed; degrade to empty (no cached identities)',
      );
      return {};
    });

    this.poller = createPoller({
      bootstrap: this.bootstrap,
      stateStore: this.stateStore,
      archiveStore: this.archiveStore,
      logger: this.logger,
      onTickExtras: () => {
        // PRs removed / purged this round: terminate agent operations still running on them (before AutoPilot, to avoid starting new reviews for disappeared PRs).
        this.ipcControl?.terminateAgentsForGonePrs();
        // Also do version update detection: internally timestamp-gated to at most once per hour, reusing the poller cycle, no separate timer.
        void this.updater.runIfDue();
        // AutoPilot pre-review: when switch + minimum interval + candidates are met, run a pass (internally gated, reusing the poller cycle).
        this.ipcControl?.runAutopilotIfDue();
      },
      getRepoMirror: () => this.repoMirror,
      getConnectionRuntime: () => this.conns.runtime,
      // Comment-type alerts (reply / mention) also invalidate that PR's comment cache + broadcast comments:changed, so a view currently showing it refetches immediately.
      invalidateCommentsCache: (localId) => this.ipcControl?.invalidateCommentsCache(localId),
    });

    // Connection runtime (wiring / ping / hot reconfigure): depends on the already-built poller; repoMirror reads adapterByHost via conns.runtime.
    this.conns = new ConnectionRuntimeController(
      this.bootstrap,
      this.stateStore,
      this.poller,
      this.logger,
      connectionStates,
    );

    this.repoMirror = createRepoMirror({
      bootstrap: this.bootstrap,
      logger: this.logger,
      connectionRuntime: this.conns.runtime,
    });

    // Wire connections synchronously before creating the window (no network): build adapters, pre-warm currentUser with
    // locally persisted identity, feed the poller. This way app:connections and the first-round approved check don't
    // depend on network; ping is left to refresh fully asynchronously after the window is created.
    this.conns.wire();

    this.ipcControl = registerIpcHandlers({
      bootstrap: this.bootstrap,
      logger: this.logger,
      // Lazy read: after the probe backfills asynchronously, the handler picks up the latest value only when called (the probe may not be done at registration time)
      getPrAgentStatus: () => this.prAgent.probe,
      getPrAgentBridge: () => this.prAgent.getBridge(),
      embeddedPythonPath: this.prAgent.embeddedPythonPath,
      stateStore: this.stateStore,
      archiveStore: this.archiveStore,
      poller: this.poller,
      connectionRuntime: this.conns.runtime,
      reconfigureConnections: () => this.conns.reconfigure(),
      repoMirror: this.repoMirror,
      // Lazy reference: ApiServer is constructed only after registerIpcHandlers (its request handling depends on the
      // ControllerContext singleton installed only at this moment); the closure picks up the latest instance only when config:setService is called.
      reconfigureApiServer: () => this.apiServer?.reconfigure() ?? Promise.resolve(),
    });

    // Local API service listener: ControllerContext is already installed by registerIpcHandlers, so requests can be handled safely.
    // config.service decides whether to actually listen (off by default); a listen failure is non-fatal (internally logged as a fallback).
    this.apiServer = new ApiServer({ bootstrap: this.bootstrap, logger: this.logger });
    await this.apiServer.start();
  }

  /**
   * ④ Native chrome after whenReady (menu/Dock icon/dark) + splash + main window + activate rebuild.
   */
  private async initWindow(): Promise<void> {
    // No Electron default menu bar (File/Edit/View/...), meebox provides its own toolbar
    Menu.setApplicationMenu(null);

    await app.whenReady();

    // In dev the Dock icon uses the generic Electron.app (not baked into icns by electron-builder) → manually set the mac-specific icon.
    // In packaged mode the Dock icon is decided by the bundle's icns, no need and should not override here. Only mac has app.dock.
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(path.join(app.getAppPath(), '../../assets/icons/icon-mac.png'));
    }

    // Windows toast notifications require AppUserModelId to match the installer's appId, otherwise the system may not
    // show them / attribute them wrongly. dev uses a .dev suffix: AUMID is Windows's persistent cache key for taskbar
    // icon/grouping/pinning, and dev runs electron.exe with its own default icon; sharing the same AUMID with packaged
    // mode would cache the Electron icon under that key → the released build after install still reuses the old cache
    // and shows the Electron icon in the taskbar. Separating them keeps them from polluting each other.
    if (process.platform === 'win32') {
      app.setAppUserModelId(
        app.isPackaged ? 'com.huhamhire.code-meeseeks' : 'com.huhamhire.code-meeseeks.dev',
      );
    }

    // Native window chrome follows the global theme: Windows sets DWMWA_USE_IMMERSIVE_DARK_MODE based on nativeTheme
    // (native thin border / window-control button light-dark). themeSource is inferred back from the theme—the 'auto'
    // theme hands it back to the OS ('system'), the rest are fixed light / dark. Window-control button colors are synced
    // by WindowManager listening to nativeTheme 'updated' (see window-manager).
    nativeTheme.themeSource = editorThemeNativeSource(this.bootstrap.config.appearance.editor_theme);

    // Main window management (load window state + create window + write back size).
    this.windowManager = await loadWindowManager({
      stateStore: this.stateStore,
      stateDir: this.bootstrap.paths.stateDir,
      logger: this.logger,
      startMs: this.startMs,
    });

    // Pop a lightweight splash first (data URL, visible within tens of ms) to cover the ~2s loading blank before the main
    // window's first frame. Close it when the main window is ready-to-show. Colors follow the effective theme
    // (shouldUseDarkColors already resolves 'system' based on the themeSource above).
    const splash = createSplash(nativeTheme.shouldUseDarkColors);
    this.windowManager.create(splash);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.windowManager.create();
    });
  }

  /**
   * ⑤ The startup critical path is already network-free: after archiving (local IO), start the poller, then async ping to refresh remote identity.
   */
  private async startPolling(): Promise<void> {
    await this.poller.archiveConnectionsExcept(this.conns.activeConnectionIds());
    // Whether the active connection already has a cached identity (conns.wire pre-warmed with locally persisted identity):
    // - Yes → poller runs the first round immediately (me is ready, classification correct);
    // - No → **don't run a half-baked first round with me=null**, only install the timer; the first sync is instead
    //   triggered by conns.ping below right after ping confirms identity (an active connection with no identity must tick once after ping settles).
    // This way "first startup / missing state" is also "confirm identity first, then sync once", avoiding a first round that marks everything pending or looks like it didn't sync.
    const activeHasIdentity = this.conns.runtime.adapters.some(
      (a) =>
        a.connectionId === this.bootstrap.config.active_connection_id &&
        a.adapter.connection.getCurrentUser() != null,
    );
    this.poller.start(activeHasIdentity);
    this.logger.info(
      {
        connections: this.bootstrap.config.connections.length,
        activeId: this.bootstrap.config.active_connection_id,
        activeHasIdentity,
      },
      'poller started',
    );
    // ping refreshes remote identity fully asynchronously (not on the startup critical path): refreshes/persists
    // currentUser, and does an extra poll round if identity changes. This is the fallback source when there's "no local
    // identity record" (first run / missing state); a slow or unreachable ping doesn't affect the already-started UI.
    this.conns.ping();
  }

  /**
   * App-level lifecycle: exit cleanup (stop polling + terminate the child process tree of running runs), quit on window close, focus on second launch.
   */
  private registerLifecycle(): void {
    // Exit cleanup: stop polling + terminate the child process tree of all in-progress pr-agent runs (python + litellm and other grandchild processes).
    // Not cleaning up leaves orphan processes locking the install directory → NSIS reports "the app cannot be closed" during upgrade.
    app.on('before-quit', (event) => {
      if (this.poller) this.poller.stop();
      // Stop the local API listener (stop accepting new connections); fire-and-forget, closes quickly, doesn't block exit.
      void this.apiServer?.stop();
      if (this.quitCleanupDone) return;
      const aborted = this.ipcControl?.abortAllActiveRuns() ?? 0;
      if (aborted === 0) return; // No in-progress run, exit directly
      // Runs are in progress: abort has triggered each exec's killTree (win32=taskkill /T /F, async). Defer the actual
      // exit to let taskkill finish, avoiding the main process exiting first while grandchild processes aren't fully killed.
      event.preventDefault();
      this.quitCleanupDone = true;
      if (this.logger) {
        this.logger.info({ abortedRuns: aborted }, 'terminating active pr-agent runs before quit');
      }
      setTimeout(() => app.quit(), 800);
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });

    // Second launch (user clicks the icon again / relaunches from command line) → focus the existing window, restore first if minimized.
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
}

/**
 * Process entry:
 * ① OS/platform startup tweaks (must be before whenReady; includes Windows console encoding / macOS keychain + PATH completion).
 * ② Single-instance lock—only one instance allowed at a time; multiple instances would share the same config.yaml /
 *    repos mirror / state store causing write contention, so whoever fails to get the lock exits directly (the existing
 *    instance's second-instance callback focuses the window).
 * ③ If the lock is acquired, construct App and start.
 */
function main(): void {
  applyOsStartupTweaks();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  void new App(PROCESS_START_MS).run();
}

main();
