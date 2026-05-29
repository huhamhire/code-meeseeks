import type { IpcChannelName, IpcChannels } from '@pr-pilot/shared';

export function invoke<K extends IpcChannelName>(
  channel: K,
  req: IpcChannels[K]['request'],
): Promise<IpcChannels[K]['response']> {
  return window.api.invoke(channel, req);
}
