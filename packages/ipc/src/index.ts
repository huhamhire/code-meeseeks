import type { AgentChannels } from './agent.js';
import type { AppChannels } from './app.js';
import type { ConfigChannels } from './config.js';
import type { IpcEventName, IpcEvents } from './events.js';
import type { PrChannels } from './pr.js';

export * from './common.js';
export * from './events.js';
export * from './app.js';
export * from './pr.js';
export * from './config.js';
export * from './agent.js';

/**
 * Typed IPC channel contract.
 *
 * Maintained split by business domain (app / pr / config / agent), merged here into a single map.
 * The preload bridge and main handlers both reference this map so that
 * Renderer ↔ Main calls stay end-to-end type-safe.
 */
export type IpcChannels = AppChannels & PrChannels & ConfigChannels & AgentChannels;

export type IpcChannelName = keyof IpcChannels;

export interface IpcBridge {
  invoke<K extends IpcChannelName>(
    channel: K,
    req: IpcChannels[K]['request'],
  ): Promise<IpcChannels[K]['response']>;
  /** Subscribe to main → renderer push events; returns an unsubscribe function. */
  subscribe<E extends IpcEventName>(event: E, handler: (data: IpcEvents[E]) => void): () => void;
}
