import type { IpcMainInvokeEvent } from 'electron';
import type { IpcChannelName, IpcChannels } from '@meebox/ipc';

/**
 * IPC controller 的类型：原生 `ipcMain.handle` 监听器形态 `(event, req)`，直接
 * `ipcMain.handle('channel', controller)` 注册、无包装层。通道字符串与 controller 的匹配由
 * ipcMain.handle 的宽松签名兜不住，靠注册处命名 + 注释保证。
 *
 * @template K 通道名（约束 `extends IpcChannelName` 必需：req/response 由 `IpcChannels[K]` 索引取出）。
 * @param event electron IpcMainInvokeEvent；仅少数需窗口上下文的 controller 用（对话框 / DevTools），其余以 `_event` 占位。
 * @param req 该通道的强类型请求体。
 * @returns 该通道的 response（同步或异步）。
 */
export type IpcController<K extends IpcChannelName> = (
  event: IpcMainInvokeEvent,
  req: IpcChannels[K]['request'],
) => IpcChannels[K]['response'] | Promise<IpcChannels[K]['response']>;
