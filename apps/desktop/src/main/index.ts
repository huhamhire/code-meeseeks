import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@meebox/config';
import { resolveLanguage } from '@meebox/shared';
import { createLogger } from '@meebox/logger';
import { createPrAgentBridge, type PrAgentBridge } from '@meebox/pr-agent-bridge';
import { Poller } from '@meebox/poller';
import { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PlatformAdapter, PlatformUser, PrAgentStatus } from '@meebox/shared';
import { JsonFileStateStore } from '@meebox/state-store';
import { buildAdapters, type ConnectionRuntime } from './adapters.js';
import { initMainI18n } from './i18n/index.js';
import { registerIpcHandlers } from './ipc.js';
import { buildProxyEnv } from './utils/proxy.js';
import { fixMacPath } from './utils/mac-path.js';
import {
  readConnectionStates,
  writeConnectionStates,
  type ConnectionState,
} from './utils/connection-state.js';
import { readWindowState, writeWindowState, type WindowState } from './utils/window-state.js';
import { checkForUpdate } from './utils/update-check.js';

// 进程（模块加载）起点：用于度量到主窗口首帧（ready-to-show）的启动耗时。
const PROCESS_START_MS = Date.now();

// 版本更新检测节流：由 poller tick 顺带发起（不另起定时器），至多每小时一次。
// lastUpdateCheckMs 初值取进程启动时刻 → 首次检测落在启动后约 1h，刻意不在启动瞬间检测，
// 避免占用冷启动网络 / 打断启动；之后随 poller tick 每满 1h 触发一次。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let lastUpdateCheckMs = PROCESS_START_MS;

// 嵌入式 python 子进程不写 .pyc：安装目录（per-user 可写）运行期会积累上万个 __pycache__/.pyc，
// 升级时旧卸载器要 grinding 这些文件 → 卸载极慢、易拖到「应用无法关闭」。设 PYTHONDONTWRITEBYTECODE=1
// 让运行期不落 .pyc，安装目录文件数稳定（仅装包时的量）。子进程经 spawn 继承本进程 env。
// 代价：每次 python 启动重编译（略慢）；评审为 LLM 网络主导，影响有限。
process.env.PYTHONDONTWRITEBYTECODE = '1';

// macOS 免费(ad-hoc)路线：Chromium 的 os_crypt 首启会建「<App> Safe Storage」钥匙串项
// 加密 cookie/本地存储，但 ad-hoc 签名身份不稳定(cdhash 每次构建变) → 每次启动弹「访问钥匙串」。
// 用 mock keychain 让它走内存、不碰真钥匙串、不再弹。代价：cookie 加密退化为静态 key，
// 但本应用密钥本就明文落盘(config-store)，cookie 加密非依赖项，无实质损失。
// 仅 mac：本开关只控 macOS Keychain 后端；win(DPAPI)/linux(libsecret) 不受影响，故守卫掉。
// 必须在 app.whenReady() 之前；模块加载期即最早时机。有正式 Developer ID 签名后可移除。
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain');
}

// 单例锁：同一时刻只允许一个实例运行。多实例会共享同一份 config.yaml / repos 镜像 /
// state store，导致写竞争、poller 重复轮询、git 镜像并发写冲突，必须互斥。拿不到锁的
// 第二个实例直接退出，并由已有实例的 second-instance 回调把窗口聚焦到前台。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 嵌入式 pr-agent 运行时的解释器绝对路径。
 * - dev：`apps/desktop/vendor/pragent/...`（app.getAppPath() = apps/desktop）
 * - 打包：`<resources>/pragent/...`（electron-builder extraResources）
 * - `MEEBOX_PRAGENT_PYTHON` env 覆盖兜底
 * 探测层据此判断 embedded 是否可用（文件不存在则回退 local-cli）。
 */
function resolveEmbeddedPython(): string {
  const override = process.env.MEEBOX_PRAGENT_PYTHON;
  if (override) return override;
  const rel =
    process.platform === 'win32' ? ['python', 'python.exe'] : ['python', 'bin', 'python3'];
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'pragent')
    : path.join(app.getAppPath(), 'vendor', 'pragent');
  return path.join(base, ...rel);
}

let bootstrap: BootstrapResult;
let logger: Logger;
// 探测结果异步回填（见下方 kick-off）：probe 完成前 bridge=null。
let prAgentBridge: PrAgentBridge | null = null;
// 探测 promise：app:prAgentStatus 据此 await 拿最终状态；构造逻辑保证恒 resolve、不 reject。
let prAgentProbe: Promise<PrAgentStatus>;
let stateStore: JsonFileStateStore;
let poller: Poller;
let repoMirror: RepoMirrorManager;
// IPC 运行时控制句柄（registerIpcHandlers 返回）：退出时据此中止所有进行中的 pr-agent run，
// 触发其子进程树清理（见 before-quit）。注册前为 undefined。
let ipcControl: { abortAllActiveRuns: () => number } | undefined;
// 连接级本地状态（按 connectionId）：持久化上次 ping 的 currentUser，用于建连接时预热，
// 使首轮 poll 不依赖网络即可判 approved。启动时从 state store 载入一次，ping 后增量回写。
let connectionStates: Record<string, ConnectionState> = {};
// 主窗口本地状态（尺寸 / 最大化）：启动时载入一次，建窗时恢复、resize/move/close 时回写。
let windowState: WindowState = {};

async function start(): Promise<void> {
  bootstrap = await ensureWorkspace();
  // 主进程 i18n 定档（dialog 标题、错误消息等面向用户文本）。config.language 为空时
  // 按操作系统偏好语言解析、无合适项回落英语；结果同时供 pr-agent 响应语言复用，与 UI 一致。
  initMainI18n(resolveLanguage(bootstrap.config.language, app.getPreferredSystemLanguages()));
  // pretty 仅非打包态开：dev 控制台单行 + ISO8601 + 上色；打包态保持原始 JSON。
  logger = await createLogger({ logsDir: bootstrap.paths.logsDir, pretty: !app.isPackaged });
  logger.info(
    { firstRun: bootstrap.firstRun, appDir: bootstrap.paths.appDir },
    'meebox main process started',
  );

  // macOS GUI 启动（Finder/Dock）只有 launchd 最小 PATH，找不到本机 CLI（claude/codex，常在
  // ~/.local/bin / homebrew）。启动期前置常见目录到 process.env.PATH，使后续 spawn 的嵌入式
  // python 及其 CLI 子进程（经 {...process.env} 继承）都能定位到命令。须在 pr-agent 探测/运行前。
  const macPath = fixMacPath();
  if (macPath.applied) {
    logger.info({ added: macPath.added }, 'macOS PATH 已补全');
  }

  // main 进程全局兜底：未捕获异常 / 未处理 rejection 至少留一条日志，不静默崩溃。
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
  });

  const embeddedPythonPath = resolveEmbeddedPython();
  // pr-agent 探测**不放在建窗关键路径上**：它走 spawn 探测（auto 模式回退 local-cli
  // 时最坏 5s 超时），过去 await 在此会把窗口首帧整体推迟数秒。改为 kick-off 不 await，
  // 与 app.whenReady() + 渲染层加载并发跑；结果异步回填模块变量。
  // - app:prAgentStatus 会 await prAgentProbe 拿最终状态（boot 时序通常已完成）
  // - pragent run 入口读 getPrAgentBridge()，未就绪时为 null → 走"未就绪"提示
  prAgentProbe = (async (): Promise<PrAgentStatus> => {
    const probe = await createPrAgentBridge({
      embeddedPythonPath,
      forceStrategy: bootstrap.config.pr_agent.strategy,
    });
    prAgentBridge = probe.bridge;
    logger.info(
      {
        available: probe.status.available,
        strategy: probe.status.available ? probe.status.strategy : undefined,
        version: probe.status.available ? probe.status.version : undefined,
      },
      'pr-agent probe complete',
    );
    return probe.status;
  })();

  stateStore = new JsonFileStateStore(bootstrap.paths.stateDir);

  // 载入连接级本地状态（含上次 ping 的 currentUser）。文件不存在（首跑）→ 空表；读取/解析
  // 失败（损坏）→ 也降级为空表并记一条 warn。降级后果仅是：首轮 poll 无预热身份，待异步 ping
  // 补到 currentUser 后自动重分类（见 pingConnections），功能不受损、只是首轮可能短暂偏「待处理」。
  try {
    connectionStates = await readConnectionStates(stateStore);
  } catch (err) {
    logger.warn({ err }, 'read connection states failed; degrade to empty (no cached identities)');
    connectionStates = {};
  }

  // 载入窗口状态（尺寸/最大化）。缺失或损坏 → 空对象，建窗回退默认尺寸。
  try {
    windowState = await readWindowState(stateStore);
  } catch (err) {
    logger.warn({ err }, 'read window state failed; use default window size');
    windowState = {};
  }

  // 连接运行时（可变持有）：adapters 全量（IPC 按 id 查任意连接，历史 PR 都能操作）
  // + adapterByHost（repo-mirror 取 clone url）。reconfigureConnections 原地替换内容，
  // IPC handler / repoMirror 经引用读到新值 → 设置页改连接热生效，无需重启。
  const connectionRuntime: ConnectionRuntime = { adapters: [], adapterByHost: new Map() };

  // 连接「接线」与「ping」解耦，实现「启动不依赖网络」：
  // - wireConnections（同步、无网络）：重建 adapters/byHost、用本地持久化的上次身份预热
  //   currentUser、把活动连接喂给 poller。建窗前即可调用 → app:connections 能力位与首轮判
  //   approved 都不等网络。
  // - pingConnections（全异步、有网络）：刷新远端身份并增量持久化；活动连接身份因此变化
  //   （含「本地无记录、ping 才首次取得」）则补一轮 poll 重新分类。不在启动关键路径。

  const activeConnectionIds = (): string[] =>
    connectionRuntime.adapters
      .filter((a) => a.connectionId === bootstrap.config.active_connection_id)
      .map((a) => a.connectionId);

  const wireConnections = (): void => {
    const adapters = buildAdapters(bootstrap.config.connections, bootstrap.config.proxy);
    const byHost = new Map<string, PlatformAdapter>();
    for (const { connectionId, adapter } of adapters) {
      // 预热 currentUser：有本地记录就先填上（无记录则保持 null，由 pingConnections 兜底）。
      const cachedUser = connectionStates[connectionId]?.user;
      if (cachedUser) adapter.setCurrentUser?.(cachedUser);
      const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
      if (!conn) continue;
      try {
        byHost.set(new URL(conn.base_url).hostname, adapter);
      } catch (err) {
        logger.warn({ err, connectionId, base_url: conn.base_url }, 'invalid base_url');
      }
    }
    connectionRuntime.adapters = adapters;
    connectionRuntime.adapterByHost = byHost;
    // 只轮询当前启用的连接（同时仅一条）；其余仅保留配置不轮询
    poller.setConnections(
      adapters.filter((a) => a.connectionId === bootstrap.config.active_connection_id),
    );
  };

  // 持久化某连接的 currentUser（仅身份变化时写盘，避免无谓 IO）。写盘失败不影响运行。
  const persistConnectionUser = async (
    connectionId: string,
    user: PlatformUser | null,
  ): Promise<void> => {
    const prevName = connectionStates[connectionId]?.user?.name ?? null;
    if (prevName === (user?.name ?? null)) return;
    connectionStates = {
      ...connectionStates,
      [connectionId]: { ...connectionStates[connectionId], user },
    };
    try {
      await writeConnectionStates(stateStore, connectionStates);
    } catch (err) {
      logger.warn({ err, connectionId }, 'persist connection user failed');
    }
  };

  // 全异步 ping：刷新 + 持久化 currentUser；活动连接身份变化（含首次取得）则补一轮 poll 重新分类。
  const pingConnections = (): void => {
    const activeId = bootstrap.config.active_connection_id;
    for (const { connectionId, adapter } of connectionRuntime.adapters) {
      const isActive = connectionId === activeId;
      const beforeName = adapter.getCurrentUser()?.name ?? null;
      // 活动连接启动时无缓存身份 → poller.start(immediate=false) 没跑首轮；此处 ping settle 后
      // 必须触发**首次同步**（无论 ping 成功与否：成功则带确认的身份分类，失败也用 PAT 拉一轮，
      // 不让「无身份」永远等到下个 interval）。这就是「先确认身份，再立即同步一次」。
      const hadIdentity = beforeName !== null;
      void adapter.ping().then(
        async (r) => {
          logger.info(
            { connectionId, ok: r.ok, serverVersion: r.serverVersion, user: r.user?.name },
            'adapter ping',
          );
          const user = adapter.getCurrentUser();
          await persistConnectionUser(connectionId, user);
          // 触发重分类/首次同步：活动连接且（身份变化 含首次取得/换号，或本就无身份需补首轮）。
          // poller.tick 已做「进行中则补跑」，不会因撞上首轮 poll 而丢失。
          if (isActive && (!hadIdentity || (user?.name ?? null) !== beforeName)) {
            void poller.tick();
          }
        },
        (err: unknown) => {
          logger.warn({ err, connectionId }, 'adapter ping failed');
          // ping 失败但活动连接本就无缓存身份（首轮被跳过）→ 仍用 PAT 兜底同步一次，避免看似没同步。
          if (isActive && !hadIdentity) void poller.tick();
        },
      );
    }
  };

  // 设置页 config:setConnections / setProxy 后的热生效：重接线 + 归档非活动连接（本地 IO）+ 异步
  // ping。调用方（IPC）随后会 poller.tick() 立即刷新列表，ping 完成若改了身份会再补一轮。
  const reconfigureConnections = async (): Promise<void> => {
    wireConnections();
    await poller.archiveConnectionsExcept(activeConnectionIds());
    pingConnections();
  };

  poller = new Poller({
    connections: [],
    stateStore,
    intervalSeconds: bootstrap.config.poller.interval_seconds,
    logger: logger.child({ scope: 'poller' }),
    onTick: (info) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('poll:tick', info);
      }
      // 顺带做版本更新检测：内部时间戳门控成每小时至多一次，复用 poller 周期、不另起定时器
      void runUpdateCheckIfDue();
    },
    // PR 新增 / 内容变更时，顺手 syncMirror 把本地镜像跟上，让用户随后点开 PR
    // 时省一趟 fetch。失败不阻断 poll 流程 (mirror 也有自己的全局队列 + 错误隔离)
    onPrsChanged: (repos) => {
      for (const r of repos) {
        const conn = bootstrap.config.connections.find((c) => c.id === r.connectionId);
        if (!conn) continue;
        let host: string;
        try {
          host = new URL(conn.base_url).hostname;
        } catch {
          continue;
        }
        // identity 字段映射：poller 用 group/repo 中性命名，repo-mirror 仍保留
        // Bitbucket-shaped projectKey/repoSlug (跟 git 路径布局一致，沿用便于排障)
        void repoMirror.syncMirror({ host, projectKey: r.group, repoSlug: r.repo }).catch((err) => {
          logger.warn({ err, repo: r }, 'auto syncMirror after poll failed');
        });
      }
    },
  });

  repoMirror = new RepoMirrorManager({
    reposDir: bootstrap.paths.reposDir,
    getCloneUrl: async (repo) => {
      const adapter = connectionRuntime.adapterByHost.get(repo.host);
      if (!adapter) throw new Error(`no adapter for host ${repo.host}`);
      return adapter.getCloneUrl({
        projectKey: repo.projectKey,
        repoSlug: repo.repoSlug,
      });
    },
    logger: logger.child({ scope: 'repo-mirror' }),
    onProgress: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('sync:progress', event);
      }
    },
    // 出站代理：getter 每次远端 clone/fetch 求值，设置页改代理后即生效。
    proxyEnv: () => buildProxyEnv(bootstrap.config.proxy),
  });

  // 建窗前同步把连接接好（无网络）：构建 adapters、用本地持久化身份预热 currentUser、喂 poller。
  // 这样 app:connections 与首轮判 approved 都不依赖网络；ping 留到建窗后全异步刷新。
  wireConnections();

  ipcControl = registerIpcHandlers({
    bootstrap,
    logger,
    // 惰性读取：探测异步回填后，handler 调用时才取到最新值（注册时探测可能尚未完成）
    getPrAgentStatus: () => prAgentProbe,
    getPrAgentBridge: () => prAgentBridge,
    embeddedPythonPath,
    stateStore,
    poller,
    connectionRuntime,
    reconfigureConnections,
    repoMirror,
  });

  // 不要 Electron 默认菜单栏（File/Edit/View/...），meebox 自己提供工具栏
  Menu.setApplicationMenu(null);

  await app.whenReady();

  // dev 下 Dock 图标走通用 Electron.app（未经 electron-builder 烤 icns）→ 手动设成 mac 专用图标。
  // 打包态 Dock 图标由 bundle 的 icns 决定，无需且不应在此覆盖。仅 mac 有 app.dock。
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), '../../assets/icons/icon-mac.png'));
  }

  // 强制原生窗口 chrome 走深色：Windows 据此设 DWMWA_USE_IMMERSIVE_DARK_MODE，原生标题栏 +
  // 那条细边框渲染成深色，与 #1e1e1e 应用一致，不再跟随系统浅色主题（splash + 主窗口都受益）。
  // macOS/Linux 无副作用；只影响原生 chrome，应用本身已是自绘深色样式。
  nativeTheme.themeSource = 'dark';

  // 先弹轻量 splash（data URL，几十 ms 即可见），遮住主窗口首帧前的 ~2s 加载空窗。
  // 主窗口 ready-to-show 时关闭它。
  const splash = createSplash();
  createWindow(splash);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 启动关键路径已无网络调用：归档（本地 IO）后启动 poller。
  await poller.archiveConnectionsExcept(activeConnectionIds());
  // 活动连接是否已有缓存身份（wireConnections 已用本地持久化身份预热）：
  // - 有 → poller 立即跑首轮（me 就绪，分类正确）；
  // - 无 → **不跑 me=null 的半成品首轮**，只装定时器；首次同步改由下面 pingConnections 在 ping
  //   确认身份后立即触发（见 pingConnections：无身份的活动连接 ping settle 后必 tick 一次）。
  // 这样「首次启动 / state 缺失」时也是「先确认身份，再同步一次」，避免首轮全标 pending 或看似没同步。
  const activeHasIdentity = connectionRuntime.adapters.some(
    (a) =>
      a.connectionId === bootstrap.config.active_connection_id &&
      a.adapter.getCurrentUser() != null,
  );
  poller.start(activeHasIdentity);
  logger.info(
    {
      connections: bootstrap.config.connections.length,
      activeId: bootstrap.config.active_connection_id,
      activeHasIdentity,
    },
    'poller started',
  );
  // ping 全异步刷新远端身份（不在启动关键路径）：刷新/持久化 currentUser，身份变化则补一轮 poll。
  // 这是「本地无身份记录」（首跑 / state 缺失）时的兜底来源；ping 慢或不可达都不影响已启动的 UI。
  pingConnections();
}

// 退出清理：停轮询 + 终止所有进行中的 pr-agent run 的子进程树（python + litellm 等孙进程）。
// 不清理会留孤儿进程锁住安装目录 → 升级时 NSIS 报「应用无法关闭」。
let quitCleanupDone = false;
app.on('before-quit', (event) => {
  if (poller) poller.stop();
  if (quitCleanupDone) return;
  const aborted = ipcControl?.abortAllActiveRuns() ?? 0;
  if (aborted === 0) return; // 无进行中 run，直接退出
  // 有 run 在跑：abort 已触发各自 exec 的 killTree（win32=taskkill /T /F，异步）。延后真正退出，
  // 给 taskkill 跑完，避免主进程先退出、孙进程没杀干净。
  event.preventDefault();
  quitCleanupDone = true;
  if (logger) logger.info({ abortedRuns: aborted }, 'terminating active pr-agent runs before quit');
  setTimeout(() => app.quit(), 800);
});

/**
 * 读取品牌 logo 并转成 base64 data URI，内联进 splash data URL（splash 是独立 data URL
 * 文档，无法走 file:// 相对路径引用资源，故必须内联）。两路探测：
 * - 打包态：`<resources>/icon.png`（electron-builder extraResources copy）
 * - dev：仓库 `assets/icons/icon.png`
 * 两路都读不到（如 LFS 未拉取）则返回 null，splash 优雅回退为纯 spinner。
 */
function resolveSplashLogo(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), '../../assets/icons/icon.png'),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      // LFS 指针文件不是合法 PNG（无 \x89PNG magic）→ 跳过，避免 splash 显示裂图
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) continue;
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

/**
 * 版本更新检测（config.update.check_enabled 开启时）。由 poller tick 顺带发起，内部用
 * lastUpdateCheckMs 时间戳门控成「至多每小时一次」——复用既有 poll 周期，不引入额外定时器。
 * 仅检测 + 提示：有新版才广播给所有窗口（StatusBar 提示 + 跳转下载），不下载 / 不安装。失败静默。
 *
 * 时间戳在 await 前即更新，避免 await 窗口内下一次 tick 重复发起。
 */
async function runUpdateCheckIfDue(): Promise<void> {
  if (!bootstrap.config.update.check_enabled) return;
  if (Date.now() - lastUpdateCheckMs < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheckMs = Date.now();
  try {
    const result = await checkForUpdate(app.getVersion(), bootstrap.config.proxy);
    // 获取失败（网络 / 解析 / 超时 / 限流，ok=false）：只记 debug 日志，**绝不推任何 IPC** →
    // 渲染层完全无感，不弹任何提示 / chip。保证「拿不到更新信息」对用户零打扰。
    if (!result.ok) {
      logger.debug({ error: result.error }, 'update check failed (silent, no prompt)');
      return;
    }
    // 仅「检测成功且确有新版」才广播；ok=true&hasUpdate=false（已是最新）同样静默。
    if (result.hasUpdate) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('app:updateAvailable', result);
      }
      logger.info(
        { current: result.currentVersion, latest: result.latestVersion },
        'update available',
      );
    }
  } catch (err) {
    // 兜底：checkForUpdate 约定不抛；万一抛了也吞掉，绝不冒泡成任何用户可见行为。
    logger.debug({ err }, 'update check threw (silent, no prompt)');
  }
}

/**
 * 启动闪屏：独立的无边框轻量窗口，加载内联 data URL（品牌 logo + 纯 CSS spinner），
 * 几十 ms 即可呈现，遮住主窗口首帧前的渲染层加载空窗。主窗口 ready-to-show 时关闭。
 * logo 经 base64 内联（见 resolveSplashLogo），data URL 自包含、dev/打包行为一致。
 */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 280,
    height: 240,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const logo = resolveSplashLogo();
  const logoEl = logo ? `<img class="logo" src="${logo}" alt="" />` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;}
    body{background:#1e1e1e;color:#fff;-webkit-user-select:none;user-select:none;
      font-family:system-ui,'Segoe UI',Roboto,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
    .logo{width:72px;height:72px;border-radius:16px;}
    .name{font-size:17px;font-weight:600;letter-spacing:.3px;}
    .row{display:flex;align-items:center;gap:8px;color:#9d9d9d;font-size:12px;}
    .ring{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.16);
      border-top-color:#0e639c;animation:spin .8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
  </style></head><body>
    ${logoEl}<div class="name">Code Meeseeks</div>
    <div class="row"><div class="ring"></div><span>启动中…</span></div>
  </body></html>`;
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show();
  });
  return splash;
}

function createWindow(splash?: BrowserWindow): void {
  // 最小尺寸保证核心三栏 (sidebar 240 + file-tree 180 + diff 内容)
  // 在 chat-pane 折叠态下仍可用；高度兜住 pr-header + tabs + diff + statusbar
  // 尺寸优先用本地记录的上次大小（windowState），无记录回退默认 1280×800。
  const win = new BrowserWindow({
    width: windowState.width ?? 1280,
    height: windowState.height ?? 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 首帧前的窗口底色与 app 一致，避免显示瞬间白闪
    backgroundColor: '#1e1e1e',
    // 无边框 + 自绘标题栏（VS Code 风）：macOS 保留红绿灯并下移到自绘标题栏内；
    // Windows/Linux 用 titleBarOverlay 让系统继续画窗控按钮（最小化/最大化/关闭），
    // 渲染层只接管中间标题区。高度需与渲染层 .app-titlebar 一致（36px）。
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: '#1e1e1e', symbolColor: '#cccccc', height: 36 } }),
    // dev 下显式给窗口图标（assets/icons/icon.ico）；打包态窗口/任务栏图标走 exe
    // 内嵌（electron-builder），且 assets 不进 asar，故仅 dev 设置
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), '../../assets/icons/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 恢复最大化态：以正常尺寸建窗后再 maximize，使「还原」回到记录的正常大小。
  if (windowState.maximized) win.maximize();

  // 记住窗口大小：resize/move 防抖回写、关闭时立即回写。getNormalBounds 取「非最大化」尺寸，
  // 故最大化时记录的仍是还原后的正常大小。写盘失败不影响使用。
  const persistWindowState = (): void => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    windowState = { width: b.width, height: b.height, maximized: win.isMaximized() };
    void writeWindowState(stateStore, windowState).catch((err: unknown) => {
      logger.warn({ err }, 'persist window state failed');
    });
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistWindowState, 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', persistWindowState);

  // 主界面首帧就绪：关闭 splash、显示主窗口，并记录进程启动→首帧耗时（度量启动性能）。
  win.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.close();
    win.show();
    logger.info(
      { elapsedMs: Date.now() - PROCESS_START_MS },
      'main window first paint (ready-to-show)',
    );
  });

  // 把 <a target="_blank"> / window.open 都路由到 OS 默认浏览器，不在 Electron 内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 仅在拿到单例锁时才真正启动；否则上面已 app.quit()，不跑业务初始化。
if (gotSingleInstanceLock) {
  // 二次启动（用户再点图标 / 命令行再拉起）→ 聚焦已有窗口，最小化则先还原。
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  start().catch((e: unknown) => {
    if (logger) logger.fatal({ err: e }, 'startup failed');
    else console.error('meebox startup failed:', e);
    app.quit();
  });
}
