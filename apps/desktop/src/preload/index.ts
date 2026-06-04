import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcBridge,
  IpcChannelName,
  IpcChannels,
  IpcEventName,
  IpcEvents,
} from '@meebox/shared';

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
