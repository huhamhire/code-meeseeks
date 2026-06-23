import type { IpcChannelName, IpcChannels, IpcEventName, IpcEvents } from '@meebox/ipc';

export function invoke<K extends IpcChannelName>(
  channel: K,
  req: IpcChannels[K]['request'],
): Promise<IpcChannels[K]['response']> {
  return window.api.invoke(channel, req);
}

export function subscribe<E extends IpcEventName>(
  event: E,
  handler: (data: IpcEvents[E]) => void,
): () => void {
  return window.api.subscribe(event, handler);
}
