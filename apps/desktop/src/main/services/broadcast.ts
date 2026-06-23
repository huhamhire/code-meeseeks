import { BrowserWindow } from 'electron';
import type { IpcEvents } from '@meebox/ipc';

/**
 * 向所有窗口广播一条 main → renderer 推送事件。收口原先散落各处的
 * `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(...)`，
 * 并按 IpcEvents 强类型约束 event ↔ payload。
 */
export function broadcast<E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(event, payload);
  }
}
