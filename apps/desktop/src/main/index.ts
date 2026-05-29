import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { ensureWorkspace, type BootstrapResult } from '@pr-pilot/config';
import { createLogger } from '@pr-pilot/logger';
import { detectPrAgent } from '@pr-pilot/pr-agent-bridge';
import type { PrAgentStatus } from '@pr-pilot/shared';
import { registerIpcHandlers } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let bootstrap: BootstrapResult;
let logger: Logger;
let prAgentStatus: PrAgentStatus;

async function start(): Promise<void> {
  bootstrap = await ensureWorkspace();
  logger = createLogger({ logsDir: bootstrap.paths.logsDir });
  logger.info(
    { firstRun: bootstrap.firstRun, appDir: bootstrap.paths.appDir },
    'pr-pilot main process started',
  );

  prAgentStatus = await detectPrAgent();
  logger.info({ prAgentStatus }, 'pr-agent probe complete');

  registerIpcHandlers({ bootstrap, logger, prAgentStatus });

  await app.whenReady();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

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
