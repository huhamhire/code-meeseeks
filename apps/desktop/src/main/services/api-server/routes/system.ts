import { buildAppInfo } from '../../app.js';
import { getContext } from '../../context.js';
import { seg, type Route, type RouteHandler } from './shared.js';

/**
 * System / session-level endpoints: tool-layer info unrelated to any specific PR / Agent—identity (whoami)
 * and version (version). Corresponds to the CLI's root-level system commands.
 */

/**
 * Current identity and integration platform: the active connection's PAT owner (name / displayName / slug) +
 * platform kind + connection display name. All null when there's no active connection. Deliberately narrowed—no
 * capabilities (that's the large object the GUI uses for degradation).
 */
const whoami: RouteHandler = () => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const built = activeId
    ? ctx.connectionRuntime.adapters.find((a) => a.connectionId === activeId)
    : undefined;
  if (!activeId || !built) {
    return { platform: null, connectionId: null, displayName: null, user: null };
  }
  const conn = ctx.bootstrap.config.connections.find((c) => c.id === activeId);
  const user = built.adapter.connection.getCurrentUser();
  return {
    platform: built.adapter.kind,
    connectionId: activeId,
    displayName: conn?.display_name ?? activeId,
    user: user ? { name: user.name, displayName: user.displayName, slug: user.slug ?? null } : null,
  };
};

/** Server (desktop app) version, for CLI `version` to show client + server versions together. */
const version: RouteHandler = () => ({ version: buildAppInfo(getContext().bootstrap).appVersion });

export const systemRoutes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/whoami'), handler: whoami },
  { method: 'GET', segments: seg('/api/v1/version'), handler: version },
];
