/// <reference lib="dom" />
// preload runs in the renderer process, so window / DOM event types are available; tsconfig.node has no DOM lib by default,
// hence the explicit reference here (types only, no impact on output).
import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcBridge,
  IpcChannelName,
  IpcChannels,
  IpcEventName,
  IpcEvents,
} from '@meebox/ipc';

console.log('[preload] script loaded');

const bridge: IpcBridge = {
  invoke<K extends IpcChannelName>(
    channel: K,
    req: IpcChannels[K]['request'],
  ): Promise<IpcChannels[K]['response']> {
    return ipcRenderer.invoke(channel, req);
  },
  subscribe<E extends IpcEventName>(
    event: E,
    handler: (data: IpcEvents[E]) => void,
  ): () => void {
    const listener = (_evt: Electron.IpcRendererEvent, data: unknown): void => {
      handler(data as IpcEvents[E]);
    };
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

try {
  contextBridge.exposeInMainWorld('api', bridge);
  console.log('[preload] window.api exposed');
} catch (e) {
  console.error('[preload] failed to expose window.api:', e);
}

// Renderer global error fallback: forward to main so it lands in meebox.log (renderer's own console does not go to file).
// Installing the listener in preload → can capture early errors before React mounts; uses ipcRenderer.invoke directly,
// not via contextBridge. Forwarding failures are silent (to avoid the error handling itself throwing again).
function reportRendererError(msg: string, meta: Record<string, unknown>): void {
  void ipcRenderer.invoke('log:write', { level: 'error', msg, meta }).catch(() => {
    /* silent when main is not ready / channel error */
  });
}
window.addEventListener('error', (e: ErrorEvent) => {
  reportRendererError(e.message || 'window error', {
    source: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error instanceof Error ? e.error.stack : undefined,
  });
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason: unknown = e.reason;
  reportRendererError(
    `unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    { stack: reason instanceof Error ? reason.stack : undefined },
  );
});
