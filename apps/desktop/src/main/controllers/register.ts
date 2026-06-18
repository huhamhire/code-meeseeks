import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { IpcChannelName, IpcChannels } from '@meebox/ipc';
import type { ControllerContext } from '../services/context.js';

/**
 * IPC controller 的统一签名：入参 `(ctx, req, evt)`，返回该通道 response（同步或异步）。
 * - ctx：controller 层共享上下文（依赖 + 公共工具 + 跨域 service）
 * - req：该通道的强类型请求体
 * - evt：electron IpcMainInvokeEvent（仅少数需窗口上下文的 controller 用，如对话框 / DevTools）
 *
 * 泛型约束 `K extends IpcChannelName` 必需：req/response 由 `IpcChannels[K]` 索引取出，K 必须是
 * 合法通道名才能索引。controller 一律写成具名函数 `const xxx: IpcController<'channel'> = …`。
 */
export type IpcController<K extends IpcChannelName> = (
  ctx: ControllerContext,
  req: IpcChannels[K]['request'],
  evt: IpcMainInvokeEvent,
) => IpcChannels[K]['response'] | Promise<IpcChannels[K]['response']>;

/**
 * 把一个具名 controller 绑定到 `ipcMain.handle`：薄类型包装，仅把 ipcMain 的 `(evt, req)` 适配为
 * controller 约定的 `(ctx, req, evt)`。泛型 K 同时约束 channel 字面量与 controller 的通道类型，
 * 绑错（channel 与 controller 通道不一致）即编译报错。各域 `register*Controllers(ctx)` 调它注册。
 */
export function handle<K extends IpcChannelName>(
  channel: K,
  ctx: ControllerContext,
  controller: IpcController<K>,
): void {
  ipcMain.handle(channel, (evt, req: IpcChannels[K]['request']) => controller(ctx, req, evt));
}
