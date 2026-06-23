/// <reference lib="dom" />
// preload 跑在渲染进程，可用 window / DOM 事件类型；tsconfig.node 默认无 DOM lib，
// 故在此显式引入（仅类型，不影响产物）。
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

// 渲染层全局错误兜底：转发到 main 落进 meebox.log（renderer 自己的 console 不进文件）。
// 在 preload 装监听 → 能捕获 React 挂载前的早期错误；用 ipcRenderer.invoke 直连，
// 不经 contextBridge。转发失败静默（避免错误处理自身再抛）。
function reportRendererError(msg: string, meta: Record<string, unknown>): void {
  void ipcRenderer.invoke('log:write', { level: 'error', msg, meta }).catch(() => {
    /* main 未就绪 / 通道异常时静默 */
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
