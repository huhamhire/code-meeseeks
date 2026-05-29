import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@pr-pilot/config';
import { createLogger } from '@pr-pilot/logger';
import { detectPrAgent } from '@pr-pilot/pr-agent-bridge';
import { Poller } from '@pr-pilot/poller';
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
  poller = new Poller({
    connections: adapters,
    stateStore,
    intervalSeconds: bootstrap.config.poller.interval_seconds,
    logger: logger.child({ scope: 'poller' }),
  });

  registerIpcHandlers({ bootstrap, logger, prAgentStatus, stateStore, poller });

  // 配置里有连接才启动轮询；空配置下 UI 会在 M1-D 引导用户加连接
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
