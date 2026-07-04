import { agentRoutes } from './agent.js';
import { prRoutes } from './pr.js';
import { seg, type Route } from './shared.js';
import { systemRoutes } from './system.js';

/**
 * Route **aggregate registration + matching** for the local API. Handlers for each business domain live in the sibling
 * system / pr / agent modules (all reusing the same logic as the IPC controllers); this file only does registration and path
 * matching, no business logic. Full endpoint table and write boundaries: docs/arch/04-integration/01-service-api.md.
 */
export const routes: Route[] = [...systemRoutes, ...prRoutes, ...agentRoutes];

export type { Route, RouteContext, RouteHandler } from './shared.js';

/** Match a route by method + path, extracting `:param` path parameters; return null when no match. */
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
