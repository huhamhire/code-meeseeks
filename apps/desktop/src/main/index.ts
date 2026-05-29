import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@pr-pilot/config';
import { createLogger } from '@pr-pilot/logger';
import { detectPrAgent } from '@pr-pilot/pr-agent-bridge';
import { Poller } from '@pr-pilot/poller';
import { RepoMirrorManager } from '@pr-pilot/repo-mirror';
import type { PrAgentStatus } from '@pr-pilot/shared';
import { JsonFileStateStore } from '@pr-pilot/state-store';
import { buildAdapters } from './adapters.js';
import { registerIpcHandlers } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bootstrap: BootstrapResult;
let logger: Logger;
let prAgentStatus: PrAgentStatus;
let stateStore: JsonFileStateStore;
let poller: Poller;
let repoMirror: RepoMirrorManager;

async function start(): Promise<void> {
  bootstrap = await ensureWorkspace();
  logger = createLogger({ logsDir: bootstrap.paths.logsDir });
  logger.info(
    { firstRun: bootstrap.firstRun, appDir: bootstrap.paths.appDir },
    'pr-pilot main process started',
  );

  prAgentStatus = await detectPrAgent();
  logger.info({ prAgentStatus }, 'pr-agent probe complete');

  stateStore = new JsonFileStateStore(bootstrap.paths.stateDir);
  const adapters = buildAdapters(bootstrap.config.connections);

  // 启动时 ping 一次每个连接，让 adapter 拿到当前用户缓存，poller 首轮就能
  // 根据 currentUser 判 approved 状态。失败不阻塞应用启动。
  for (const { connectionId, adapter } of adapters) {
    try {
      const r = await adapter.ping();
      logger.info(
        {
          connectionId,
          ok: r.ok,
          serverVersion: r.serverVersion,
          user: r.user?.name,
        },
        'adapter ping at startup',
      );
    } catch (err) {
      logger.warn({ err, connectionId }, 'adapter startup ping failed');
    }
  }

  poller = new Poller({
    connections: adapters,
    stateStore,
    intervalSeconds: bootstrap.config.poller.interval_seconds,
    logger: logger.child({ scope: 'poller' }),
  });

  // host → adapter 反向索引，repoMirror 拿 clone URL 时按 RepoIdentity.host 路由。
  // 一期通常单连接，但接口预留多连接（同 host 多 PAT 暂不支持，最后写入胜出）。
  const adapterByHost = new Map<string, (typeof adapters)[number]['adapter']>();
  for (const { connectionId, adapter } of adapters) {
    const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
    if (!conn) continue;
    try {
      adapterByHost.set(new URL(conn.base_url).host, adapter);
    } catch (err) {
      logger.warn({ err, connectionId, base_url: conn.base_url }, 'invalid base_url');
    }
  }

  repoMirror = new RepoMirrorManager({
    reposDir: bootstrap.paths.reposDir,
    getCloneUrl: async (repo) => {
      const adapter = adapterByHost.get(repo.host);
      if (!adapter) throw new Error(`no adapter for host ${repo.host}`);
      return adapter.getCloneUrl(
        { projectKey: repo.projectKey, repoSlug: repo.repoSlug },
        { withAuth: true },
      );
    },
    logger: logger.child({ scope: 'repo-mirror' }),
  });

  registerIpcHandlers({
    bootstrap,
    logger,
    prAgentStatus,
    stateStore,
    poller,
    adapters,
    repoMirror,
  });

  // 不要 Electron 默认菜单栏（File/Edit/View/...），pr-pilot 自己提供工具栏
  Menu.setApplicationMenu(null);

  // 配置里有连接才启动轮询；空配置下 UI 引导用户加连接
  if (adapters.length > 0) {
    poller.start();
    logger.info({ connections: adapters.length }, 'poller started');
  } else {
    logger.info('no connections configured; poller stays idle');
  }

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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
