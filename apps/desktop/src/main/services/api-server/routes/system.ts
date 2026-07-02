import { buildAppInfo } from '../../app.js';
import { getContext } from '../../context.js';
import { seg, type Route, type RouteHandler } from './shared.js';

/**
 * 系统性 / 会话级端点：与具体 PR / Agent 无关的工具层信息——身份（whoami）与版本（version）。
 * 对应 CLI 的根层级系统性命令。
 */

/**
 * 当前身份与集成平台：活动连接的 PAT 所属用户（name / displayName / slug）+ 平台种类 +
 * 连接显示名。无活动连接时各项为 null。刻意收窄——不带 capabilities（那是 GUI 降级用的大对象）。
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

/** 服务端（桌面应用）版本，供 CLI `version` 同时展示客户端 + 服务端版本。 */
const version: RouteHandler = () => ({ version: buildAppInfo(getContext().bootstrap).appVersion });

export const systemRoutes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/whoami'), handler: whoami },
  { method: 'GET', segments: seg('/api/v1/version'), handler: version },
];
