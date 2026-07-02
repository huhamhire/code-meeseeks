import { agentRoutes } from './agent.js';
import { prRoutes } from './pr.js';
import { seg, type Route } from './shared.js';
import { systemRoutes } from './system.js';

/**
 * 本地 API 的路由**聚合注册 + 匹配**。各业务领域的处理器分置于同目录的 system / pr / agent 模块
 * （均复用 IPC controller 同源逻辑）；本文件只做注册与路径匹配，不含业务逻辑。
 * 端点全表与写边界见 docs/arch/04-integration/01-service-api.md。
 */
export const routes: Route[] = [...systemRoutes, ...prRoutes, ...agentRoutes];

export type { Route, RouteContext, RouteHandler } from './shared.js';

/** 按方法 + 路径匹配路由，提取 `:param` 路径参数；无匹配返回 null。 */
export function matchRoute(
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  const parts = seg(pathname);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const s = route.segments[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}
