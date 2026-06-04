import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@pr-pilot/config';
import { createLogger } from '@pr-pilot/logger';
import { createPrAgentBridge, type PrAgentBridge } from '@pr-pilot/pr-agent-bridge';
import { Poller } from '@pr-pilot/poller';
import { RepoMirrorManager } from '@pr-pilot/repo-mirror';
import type { PlatformAdapter, PrAgentStatus } from '@pr-pilot/shared';
import { JsonFileStateStore } from '@pr-pilot/state-store';
import { buildAdapters, type ConnectionRuntime } from './adapters.js';
import { registerIpcHandlers } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 嵌入式 pr-agent 运行时的解释器绝对路径（见 ADR-0008）。
 * - dev：`apps/desktop/vendor/pragent/...`（app.getAppPath() = apps/desktop）
 * - 打包：`<resources>/pragent/...`（electron-builder extraResources）
 * - `PRPILOT_PRAGENT_PYTHON` env 覆盖兜底
 * 探测层据此判断 embedded 是否可用（文件不存在则回退 local-cli/docker）。
 */
function resolveEmbeddedPython(): string {
  const override = process.env.PRPILOT_PRAGENT_PYTHON;
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
let prAgentStatus: PrAgentStatus;
let prAgentBridge: PrAgentBridge | null;
let stateStore: JsonFileStateStore;
let poller: Poller;
let repoMirror: RepoMirrorManager;

async function start(): Promise<void> {
  bootstrap = await ensureWorkspace();
  logger = await createLogger({ logsDir: bootstrap.paths.logsDir });
  logger.info(
    { firstRun: bootstrap.firstRun, appDir: bootstrap.paths.appDir },
    'pr-pilot main process started',
  );

  const embeddedPythonPath = resolveEmbeddedPython();
  const probe = await createPrAgentBridge({
    embeddedPythonPath,
    forceStrategy: bootstrap.config.pr_agent.strategy,
  });
  prAgentStatus = probe.status;
  prAgentBridge = probe.bridge;
  logger.info(
    {
      available: prAgentStatus.available,
      strategy: prAgentStatus.available ? prAgentStatus.strategy : undefined,
      version: prAgentStatus.available ? prAgentStatus.version : undefined,
    },
    'pr-agent probe complete',
  );

  stateStore = new JsonFileStateStore(bootstrap.paths.stateDir);

  // 连接运行时（可变持有）：adapters 全量（IPC 按 id 查任意连接，历史 PR 都能操作）
  // + adapterByHost（repo-mirror 取 clone url）。reconfigureConnections 原地替换内容，
  // IPC handler / repoMirror 经引用读到新值 → 设置页改连接热生效，无需重启。
  const connectionRuntime: ConnectionRuntime = { adapters: [], adapterByHost: new Map() };

  // 重建 adapters + ping（缓存 currentUser）+ 重算 adapterByHost + 把"当前启用"的那条
  // 喂给 poller。启动时跑一次；设置页 config:setConnections 后再跑实现热生效。不在此 tick。
  const reconfigureConnections = async (): Promise<void> => {
    const adapters = buildAdapters(bootstrap.config.connections);
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
        // BBS-shaped projectKey/repoSlug (跟 git 路径布局一致，沿用便于排障)
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
  });

  // 初次构建连接（含 ping + 把 active 连接喂给 poller）
  await reconfigureConnections();

  registerIpcHandlers({
    bootstrap,
    logger,
    prAgentStatus,
    prAgentBridge,
    embeddedPythonPath,
    stateStore,
    poller,
    connectionRuntime,
    reconfigureConnections,
    repoMirror,
  });

  // 不要 Electron 默认菜单栏（File/Edit/View/...），pr-pilot 自己提供工具栏
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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('before-quit', () => {
  if (poller) poller.stop();
});

function createWindow(): void {
  // 最小尺寸保证核心三栏 (sidebar 240 + file-tree 180 + diff 内容)
  // 在 chat-pane 折叠态下仍可用；高度兜住 pr-header + tabs + diff + statusbar
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

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

start().catch((e: unknown) => {
  if (logger) logger.fatal({ err: e }, 'startup failed');
  else console.error('pr-pilot startup failed:', e);
  app.quit();
});
