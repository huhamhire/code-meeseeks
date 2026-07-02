import type { IpcMainInvokeEvent } from 'electron';

/**
 * 路由框架原语，供同目录各业务领域模块（system / pr / agent）与聚合器（index）共用。
 * 各域处理器**复用 IPC controller 同源逻辑**——controller 形态为 `(event, req)` 且这些路径不触碰
 * event，故以 {@link NO_EVENT} 占位调用，避免在 HTTP 侧另起一套实现。
 */

/** 单条路由处理器的入参：路径参数 / 查询串 / 已解析 body。 */
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

/** 把 `/api/v1/prs/:id` 切成非空段数组（注册与匹配共用）。 */
export function seg(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** controller 形参 event 在被复用的只读 / 队列路径中均未使用，占位即可。 */
export const NO_EVENT = undefined as unknown as IpcMainInvokeEvent;
