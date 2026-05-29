import { contextBridge, ipcRenderer } from 'electron';
import type { IpcBridge, IpcChannelName, IpcChannels } from '@pr-pilot/shared';

console.log('[preload] script loaded');

const bridge: IpcBridge = {
  invoke<K extends IpcChannelName>(
    channel: K,
    req: IpcChannels[K]['request'],
  ): Promise<IpcChannels[K]['response']> {
    return ipcRenderer.invoke(channel, req);
  },
};

try {
  contextBridge.exposeInMainWorld('api', bridge);
  console.log('[preload] window.api exposed');
} catch (e) {
  console.error('[preload] failed to expose window.api:', e);
}
