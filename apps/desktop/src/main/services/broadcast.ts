import { BrowserWindow } from 'electron';
import type { IpcEvents } from '@meebox/ipc';

/**
 * Broadcasts a main → renderer push event to all windows. Consolidates the previously
 * scattered `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(...)`,
 * and strongly constrains event ↔ payload via IpcEvents.
 */
export function broadcast<E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(event, payload);
  }
}
