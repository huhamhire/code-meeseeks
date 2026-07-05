import type { IpcMainInvokeEvent } from 'electron';
import type { IpcChannelName, IpcChannels } from '@meebox/ipc';

/**
 * Type of an IPC controller: the native `ipcMain.handle` listener shape `(event, req)`, registered directly via
 * `ipcMain.handle('channel', controller)` with no wrapper layer. The match between the channel string and the controller is not
 * caught by ipcMain.handle's loose signature; it is guaranteed by naming + comments at the registration site.
 *
 * @template K Channel name (the `extends IpcChannelName` constraint is required: req/response are indexed out of `IpcChannels[K]`).
 * @param event electron IpcMainInvokeEvent; used only by the few controllers needing window context (dialogs / DevTools), the rest use `_event` as a placeholder.
 * @param req The channel's strongly-typed request body.
 * @returns The channel's response (sync or async).
 */
export type IpcController<K extends IpcChannelName> = (
  event: IpcMainInvokeEvent,
  req: IpcChannels[K]['request'],
) => IpcChannels[K]['response'] | Promise<IpcChannels[K]['response']>;
