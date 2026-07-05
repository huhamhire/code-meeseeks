import fs from 'node:fs';
import path from 'node:path';
import type { StateStore } from '@meebox/state-store';

/**
 * Local state of the main window (persisted in the state store), so the next launch reuses the previous window size.
 * Stores only size + maximized state, not x/y position — with multiple displays / resolution changes, restoring by coordinates easily places the window off-screen,
 * whereas size restoration has no such risk and matches the "remember window size" intent (on window creation, centered within the current display's work area, see window-manager).
 */
export interface WindowState {
  width?: number;
  height?: number;
  /** Whether it was maximized at last close; if so, the next launch creates the window at normal size then maximizes. */
  maximized?: boolean;
}

const KEY = 'window/state';

/** Read the window state; on no file / read failure the caller falls back to empty. */
export async function readWindowState(store: StateStore): Promise<WindowState> {
  return (await store.read<WindowState>(KEY)) ?? {};
}

/** Write the window state back (in-session debounced writeback goes through the store, concurrency-safe + atomic). */
export async function writeWindowState(store: StateStore, state: WindowState): Promise<void> {
  await store.write<WindowState>(KEY, state);
}

/**
 * Synchronous write to disk on window close: after the `close` event the process exits immediately (Windows/Linux quit on closing the last window), an async write cannot flush in time
 * → size lost. So window close uses a synchronous write as fallback. The path matches JsonFileStateStore's key→path mapping (`<stateDir>/window/state.json`).
 */
export function writeWindowStateSync(stateDir: string, state: WindowState): void {
  const file = path.join(stateDir, `${KEY}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
