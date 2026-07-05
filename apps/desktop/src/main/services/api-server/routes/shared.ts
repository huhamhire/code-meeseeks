import type { IpcMainInvokeEvent } from 'electron';

/**
 * Route framework primitives, shared by the same-directory business domain modules (system / pr / agent)
 * and the aggregator (index). Each domain handler **reuses the IPC controller's same-source logic**—the
 * controller shape is `(event, req)` and these paths never touch event, so they call with {@link NO_EVENT}
 * as a placeholder, avoiding a separate implementation on the HTTP side.
 */

/** A single route handler's inputs: path params / query string / parsed body. */
export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (rc: RouteContext) => Promise<unknown> | unknown;

export interface Route {
  method: 'GET' | 'POST';
  segments: string[];
  handler: RouteHandler;
}

/** Split `/api/v1/prs/:id` into a non-empty segment array (shared by registration and matching). */
export function seg(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** The controller's event parameter is unused across the reused read-only / queue paths, so a placeholder suffices. */
export const NO_EVENT = undefined as unknown as IpcMainInvokeEvent;
