import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@pr-pilot/config';
import { createLogger } from '@pr-pilot/logger';
import { createPrAgentBridge, type PrAgentBridge } from '@pr-pilot/pr-agent-bridge';
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

  const probe = await createPrAgentBridge();
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

  // hostname → adapter 反向索引（不带端口，与 RepoIdentity.host 对齐）。
  // 一期通常单连接，但接口预留多连接（同 host 多 PAT 暂不支持，最后写入胜出）。
  const adapterByHost = new Map<string, (typeof adapters)[number]['adapter']>();
  for (const { connectionId, adapter } of adapters) {
    const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
    if (!conn) continue;
    try {
      adapterByHost.set(new URL(conn.base_url).hostname, adapter);
    } catch (err) {
      logger.warn({ err, connectionId, base_url: conn.base_url }, 'invalid base_url');
    }
  }

  repoMirror = new RepoMirrorManager({
    reposDir: bootstrap.paths.reposDir,
    getCloneUrl: async (repo) => {
      const adapter = adapterByHost.get(repo.host);
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

  registerIpcHandlers({
    bootstrap,
    logger,
    prAgentStatus,
    prAgentBridge,
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
