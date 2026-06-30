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
import { readConnectionStates } from './utils/connection-state.js';

// 进程（模块加载）起点：用于度量到主窗口首帧（ready-to-show）的启动耗时。
const PROCESS_START_MS = Date.now();

// registerIpcHandlers 返回的运行时控制句柄：退出时据此中止所有进行中的 pr-agent run（触发其
// 子进程树清理，见 before-quit）；poll tick 顺带做 AutoPilot 准入与清理已消失 PR 的在跑操作。
type IpcControl = {
  abortAllActiveRuns: () => number;
  runAutopilotIfDue: () => void;
  terminateAgentsForGonePrs: () => void;
};

/**
 * 应用组合根：持有各子系统实例（fields），分域初始化（workspace/日志 → 各 runtime → 连接/poller/IPC →
 * 窗口 → 启动轮询）并挂接 app 生命周期。唯一入口 main()：进程微调 → 单例锁 → new App().run()。
 * 各 runtime 的构造/工厂均在 bootstrap/ 域内，本类只负责装配与生命周期编排。
 */
class App {
  private bootstrap!: BootstrapResult;
  private logger!: Logger;
  private stateStore!: JsonFileStateStore;
  /** 归档 PR 冷存储（`archived/` 根，与 state/ 平级）；退场 PR 整树搬入、按 grace 期清理。 */
  private archiveStore!: JsonFileStateStore;
  private poller!: Poller;
  private repoMirror!: RepoMirrorManager;
  private prAgent!: PrAgentRuntime;
  private updater!: Updater;
  private conns!: ConnectionRuntimeController;
  private windowManager!: WindowManager;
  private ipcControl?: IpcControl;
  private quitCleanupDone = false;

  constructor(private readonly startMs: number) {}

  /**
   * 唯一启动序列：挂接生命周期 → 分域初始化；任一阶段抛错则记 fatal 并退出。
   */
  async run(): Promise<void> {
    this.registerLifecycle();
    try {
      await this.bootstrapCore();
      this.initRuntimes();
      // 清扫上次会话残留的原子写临时文件（进程在 write↔rename 之间退出留下的孤儿 tmp）。
      // 启动早期、任何写入之前清扫，单写者前提下安全（见 JsonFileStateStore.sweepStaleTmpFiles）。
      await this.stateStore
        .sweepStaleTmpFiles()
        .catch((err: unknown) => this.logger.warn({ err }, 'state-store: tmp sweep failed'));
      // 归档冷存储同样清扫上次会话残留的原子写 tmp（搬迁中途退出可能留下孤儿）。
      await this.archiveStore
        .sweepStaleTmpFiles()
        .catch((err: unknown) => this.logger.warn({ err }, 'archive-store: tmp sweep failed'));
      // 归档孤儿清扫：统一索引丢失 / 重建后，归档数据失去索引条目、按索引遍历的硬清够不到 → 永久孤儿。
      // 启动期（任何写入之前）按「索引无条目 + 目录 mtime 超 grace」无索引兜底回收（见 docs/arch/03）。
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
   * ① workspace 落定 + i18n 定档 + 日志就绪 + Agent 目录脚手架 + macOS PATH 补全 + 全局兜底。
   */
  private async bootstrapCore(): Promise<void> {
    this.bootstrap = await ensureWorkspace();
    // 主进程 i18n 定档（dialog 标题、错误消息等面向用户文本）。config.language 为空时
    // 按操作系统偏好语言解析、无合适项回落英语；结果同时供 pr-agent 响应语言复用，与 UI 一致。
    initMainI18n(
      resolveLanguage(this.bootstrap.config.language, app.getPreferredSystemLanguages()),
    );
    // pretty 仅非打包态开：dev 控制台单行 + ISO8601 + 上色；打包态保持原始 JSON。
    this.logger = await createLogger({
      logsDir: this.bootstrap.paths.logsDir,
      pretty: !app.isPackaged,
    });
    this.logger.info(
      { firstRun: this.bootstrap.firstRun, appDir: this.bootstrap.paths.appDir },
      'meebox main process started',
    );

    // Agent 目录脚手架：补齐**生效目录**的模版（用户配置的 agent.dir 优先，未配置回落默认 agent/——与
    // ipc.ts effectiveAgentDir 同口径）。此前误用默认目录，配置了自定义目录时该目录不会被初始化、启动加载
    // 到空目录。幂等（已存在不覆盖），使首次使用即有 SOUL/AGENTS 等上下文文件可读。失败不阻断启动
    // （运行期 loadAgentContext 仍会按缺失文件降级 + warn）。改 agent.dir 后的补齐见 config.setAgent。
    const agentDir = this.bootstrap.config.agent.dir || this.bootstrap.paths.agentDir;
    void scaffoldAgentDir(agentDir)
      .then((created) => {
        if (created.length) this.logger.info({ created }, 'agent dir scaffolded');
      })
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'scaffold agent dir failed');
      });

    // main 进程全局兜底：未捕获异常 / 未处理 rejection 至少留一条日志，不静默崩溃。
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error({ err: reason }, 'unhandledRejection');
    });
  }

  /**
   * ② pr-agent 运行时（解释器 + kick-off 探测）+ 版本更新器 + 状态存储。
   */
  private initRuntimes(): void {
    // pr-agent 运行时：解析嵌入式解释器 + kick-off 探测（不 await，不阻塞建窗首帧），结果异步回填。
    this.prAgent = new PrAgentRuntime(this.bootstrap, this.logger);
    // 版本更新器：由 poller tick 顺带调 runIfDue（至多每小时一次，复用 poller 周期、不另起定时器）。
    this.updater = new Updater(this.bootstrap, this.logger);
    this.stateStore = new JsonFileStateStore(this.bootstrap.paths.stateDir, this.logger);
    this.archiveStore = new JsonFileStateStore(this.bootstrap.paths.archivedDir, this.logger);
  }

  /**
   * ③ 连接级本地状态 → poller → 连接运行时（接线）→ repoMirror → IPC handlers。
   */
  private async initConnectionsAndIpc(): Promise<void> {
    // 载入连接级本地状态（含上次 ping 的 currentUser）。缺失（首跑）/ 损坏 → 降级空表 + warn；后果仅首轮
    // poll 无预热身份，待异步 ping 补到 currentUser 后自动重分类，功能不受损（接线 / ping 见 connections-runtime）。
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
        // 本轮已被移除 / purge 的 PR：终止其上仍在执行的 agent 操作（先于 AutoPilot，避免给已消失的 PR 起新评审）。
        this.ipcControl?.terminateAgentsForGonePrs();
        // 顺带做版本更新检测：内部时间戳门控成每小时至多一次，复用 poller 周期、不另起定时器。
        void this.updater.runIfDue();
        // AutoPilot 预评审：满足开关 + 最小间隔 + 候选时跑一遍 pass（内部门控，复用 poller 周期）。
        this.ipcControl?.runAutopilotIfDue();
      },
      getRepoMirror: () => this.repoMirror,
      getConnectionRuntime: () => this.conns.runtime,
    });

    // 连接运行时（接线 / ping / 热重配）：依赖已建好的 poller；repoMirror 经 conns.runtime 读 adapterByHost。
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

    // 建窗前同步把连接接好（无网络）：构建 adapters、用本地持久化身份预热 currentUser、喂 poller。
    // 这样 app:connections 与首轮判 approved 都不依赖网络；ping 留到建窗后全异步刷新。
    this.conns.wire();

    this.ipcControl = registerIpcHandlers({
      bootstrap: this.bootstrap,
      logger: this.logger,
      // 惰性读取：探测异步回填后，handler 调用时才取到最新值（注册时探测可能尚未完成）
      getPrAgentStatus: () => this.prAgent.probe,
      getPrAgentBridge: () => this.prAgent.getBridge(),
      embeddedPythonPath: this.prAgent.embeddedPythonPath,
      stateStore: this.stateStore,
      archiveStore: this.archiveStore,
      poller: this.poller,
      connectionRuntime: this.conns.runtime,
      reconfigureConnections: () => this.conns.reconfigure(),
      repoMirror: this.repoMirror,
    });
  }

  /**
   * ④ whenReady 后的原生 chrome（菜单/Dock 图标/深色）+ splash + 主窗口 + activate 重建。
   */
  private async initWindow(): Promise<void> {
    // 不要 Electron 默认菜单栏（File/Edit/View/...），meebox 自己提供工具栏
    Menu.setApplicationMenu(null);

    await app.whenReady();

    // dev 下 Dock 图标走通用 Electron.app（未经 electron-builder 烤 icns）→ 手动设成 mac 专用图标。
    // 打包态 Dock 图标由 bundle 的 icns 决定，无需且不应在此覆盖。仅 mac 有 app.dock。
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(path.join(app.getAppPath(), '../../assets/icons/icon-mac.png'));
    }

    // Windows toast 通知需 AppUserModelId 与安装包 appId 一致，否则系统可能不显示 / 归属错乱。
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.huhamhire.code-meeseeks');
    }

    // 原生窗口 chrome 跟随全局主题：Windows 据 nativeTheme 设 DWMWA_USE_IMMERSIVE_DARK_MODE（原生
    // 细边框 / 窗控按钮深浅）。themeSource 由主题反推——'auto' 主题交回 OS（'system'），其余固定浅 / 深。
    // 窗控按钮配色由 WindowManager 监听 nativeTheme 'updated' 同步（见 window-manager）。
    nativeTheme.themeSource = editorThemeNativeSource(this.bootstrap.config.appearance.editor_theme);

    // 主窗口管理（载入窗口状态 + 建窗 + 尺寸回写）。
    this.windowManager = await loadWindowManager({
      stateStore: this.stateStore,
      stateDir: this.bootstrap.paths.stateDir,
      logger: this.logger,
      startMs: this.startMs,
    });

    // 先弹轻量 splash（data URL，几十 ms 即可见），遮住主窗口首帧前的 ~2s 加载空窗。主窗口 ready-to-show
    // 时关闭它。配色跟随有效主题（shouldUseDarkColors 已据上面的 themeSource 解析 'system'）。
    const splash = createSplash(nativeTheme.shouldUseDarkColors);
    this.windowManager.create(splash);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.windowManager.create();
    });
  }

  /**
   * ⑤ 启动关键路径已无网络：归档（本地 IO）后启动 poller，再异步 ping 刷新远端身份。
   */
  private async startPolling(): Promise<void> {
    await this.poller.archiveConnectionsExcept(this.conns.activeConnectionIds());
    // 活动连接是否已有缓存身份（conns.wire 已用本地持久化身份预热）：
    // - 有 → poller 立即跑首轮（me 就绪，分类正确）；
    // - 无 → **不跑 me=null 的半成品首轮**，只装定时器；首次同步改由下面 conns.ping 在 ping
    //   确认身份后立即触发（无身份的活动连接 ping settle 后必 tick 一次）。
    // 这样「首次启动 / state 缺失」时也是「先确认身份，再同步一次」，避免首轮全标 pending 或看似没同步。
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
    // ping 全异步刷新远端身份（不在启动关键路径）：刷新/持久化 currentUser，身份变化则补一轮 poll。
    // 这是「本地无身份记录」（首跑 / state 缺失）时的兜底来源；ping 慢或不可达都不影响已启动的 UI。
    this.conns.ping();
  }

  /**
   * app 级生命周期：退出清理（停轮询 + 终止在跑 run 的子进程树）、关窗退出、二次启动聚焦。
   */
  private registerLifecycle(): void {
    // 退出清理：停轮询 + 终止所有进行中的 pr-agent run 的子进程树（python + litellm 等孙进程）。
    // 不清理会留孤儿进程锁住安装目录 → 升级时 NSIS 报「应用无法关闭」。
    app.on('before-quit', (event) => {
      if (this.poller) this.poller.stop();
      if (this.quitCleanupDone) return;
      const aborted = this.ipcControl?.abortAllActiveRuns() ?? 0;
      if (aborted === 0) return; // 无进行中 run，直接退出
      // 有 run 在跑：abort 已触发各自 exec 的 killTree（win32=taskkill /T /F，异步）。延后真正退出，
      // 给 taskkill 跑完，避免主进程先退出、孙进程没杀干净。
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

    // 二次启动（用户再点图标 / 命令行再拉起）→ 聚焦已有窗口，最小化则先还原。
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
 * 进程入口：
 * ① OS/平台启动微调（须在 whenReady 前；含 Windows 控制台编码 / macOS keychain + PATH 补全）。
 * ② 单例锁——同一时刻只允许一个实例，多实例会共享同一份 config.yaml / repos 镜像 / state store
 *    导致写竞争，拿不到锁者直接退出（由已有实例的 second-instance 回调聚焦窗口）。
 * ③ 拿到锁则构造 App 并启动。
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
