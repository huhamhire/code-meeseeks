import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@meebox/config';
import { createLogger } from '@meebox/logger';
import { createPrAgentBridge, type PrAgentBridge } from '@meebox/pr-agent-bridge';
import { Poller } from '@meebox/poller';
import { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PlatformAdapter, PrAgentStatus } from '@meebox/shared';
import { JsonFileStateStore } from '@meebox/state-store';
import { buildAdapters, type ConnectionRuntime } from './adapters.js';
import { registerIpcHandlers } from './ipc.js';
import { buildProxyEnv } from './utils/proxy.js';

// 进程（模块加载）起点：用于度量到主窗口首帧（ready-to-show）的启动耗时。
const PROCESS_START_MS = Date.now();

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
    process.platform === 'win32'
      ? ['python', 'python.exe']
      : ['python', 'bin', 'python3'];
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

async function start(): Promise<void> {
  bootstrap = await ensureWorkspace();
  // pretty 仅非打包态开：dev 控制台单行 + ISO8601 + 上色；打包态保持原始 JSON。
  logger = await createLogger({ logsDir: bootstrap.paths.logsDir, pretty: !app.isPackaged });
  logger.info(
    { firstRun: bootstrap.firstRun, appDir: bootstrap.paths.appDir },
    'meebox main process started',
  );

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

  // 连接运行时（可变持有）：adapters 全量（IPC 按 id 查任意连接，历史 PR 都能操作）
  // + adapterByHost（repo-mirror 取 clone url）。reconfigureConnections 原地替换内容，
  // IPC handler / repoMirror 经引用读到新值 → 设置页改连接热生效，无需重启。
  const connectionRuntime: ConnectionRuntime = { adapters: [], adapterByHost: new Map() };

  // 重建 adapters + ping（缓存 currentUser）+ 重算 adapterByHost + 把"当前启用"的那条
  // 喂给 poller。启动时跑一次；设置页 config:setConnections 后再跑实现热生效。不在此 tick。
  const reconfigureConnections = async (): Promise<void> => {
    const adapters = buildAdapters(bootstrap.config.connections, bootstrap.config.proxy);
    // ping 全部连接（失败不阻塞），让 poller 首轮就能按 currentUser 判 approved
    await Promise.all(
      adapters.map(async ({ connectionId, adapter }) => {
        try {
          const r = await adapter.ping();
          logger.info(
            { connectionId, ok: r.ok, serverVersion: r.serverVersion, user: r.user?.name },
            'adapter ping',
          );
        } catch (err) {
          logger.warn({ err, connectionId }, 'adapter ping failed');
        }
      }),
    );
    const byHost = new Map<string, PlatformAdapter>();
    for (const { connectionId, adapter } of adapters) {
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
    const active = adapters.filter(
      (a) => a.connectionId === bootstrap.config.active_connection_id,
    );
    poller.setConnections(active);
    // 归档非活动连接的 PR：它们已不再被轮询，否则软删段永远碰不到 → 永不 purge。
    // 这是用户显式切换/禁用连接的结果（非网络故障），交给 purge 段在 grace 期满后清理。
    await poller.archiveConnectionsExcept(active.map((a) => a.connectionId));
    logger.info(
      {
        total: adapters.length,
        active: active.length,
        activeId: bootstrap.config.active_connection_id,
      },
      'connections reconfigured',
    );
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
        void repoMirror
          .syncMirror({ host, projectKey: r.group, repoSlug: r.repo })
          .catch((err) => {
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

  // 初次构建连接（含 ping + 把 active 连接喂给 poller）
  await reconfigureConnections();

  registerIpcHandlers({
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

  // poller 常驻：当前启用连接为空时 tick 是空操作；用户在设置页启用 / 切换连接后
  // reconfigureConnections 热生效，无需重启
  poller.start();
  logger.info(
    {
      connections: bootstrap.config.connections.length,
      activeId: bootstrap.config.active_connection_id,
    },
    'poller started',
  );

  await app.whenReady();

  // dev 下 Dock 图标走通用 Electron.app（未经 electron-builder 烤 icns）→ 手动设成 mac 专用图标。
  // 打包态 Dock 图标由 bundle 的 icns 决定，无需且不应在此覆盖。仅 mac 有 app.dock。
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), '../../assets/icons/icon-mac.png'));
  }

  // 先弹轻量 splash（data URL，几十 ms 即可见），遮住主窗口首帧前的 ~2s 加载空窗。
  // 主窗口 ready-to-show 时关闭它。
  const splash = createSplash();
  createWindow(splash);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('before-quit', () => {
  if (poller) poller.stop();
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 首帧前的窗口底色与 app 一致，避免显示瞬间白闪
    backgroundColor: '#1e1e1e',
    // dev 下显式给窗口图标（assets/icons/icon.ico）；打包态窗口/任务栏图标走 exe
    // 内嵌（electron-builder），且 assets 不进 asar，故仅 dev 设置
    icon: app.isPackaged
      ? undefined
      : path.join(app.getAppPath(), '../../assets/icons/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

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
