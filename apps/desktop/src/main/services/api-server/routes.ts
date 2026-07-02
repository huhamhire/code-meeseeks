import type { IpcMainInvokeEvent } from 'electron';
import type { DiffSide } from '@meebox/ipc';
import {
  ERROR_CODES,
  PR_SECONDARY_FILTERS,
  filterPullRequests,
  type PrDiscoveryFilter,
  type PrSecondaryFilter,
  type ReviewRunTool,
} from '@meebox/shared';
import * as agentCtl from '../../controllers/agent.js';
import * as prCtl from '../../controllers/pr.js';
import { buildAppInfo } from '../app.js';
import { getContext } from '../context.js';
import { HttpError } from './http.js';
import { toPrAgentRuns, toPrListItem } from './views.js';

/**
 * 本地 API 的路由表与处理器。处理器**复用 IPC controller 同源逻辑**——controller 形态为
 * `(event, req)` 且这些路径不触碰 event，故以 NO_EVENT 占位调用，避免在 HTTP 侧另起一套实现。
 *
 * 写边界：开放**评审写操作**——approve / needswork（远端评审决断）与顶层 comment（发评论），
 * 均复用 GUI 同源 controller。仍**不**暴露：merge（合并）、pr-agent 的变更类工具（publish 等，
 * 见 agent/instruct 的只读白名单）。见 docs/arch/04-integration/01-service-api.md。
 */

// controller 形参 event 在被复用的只读 / 队列路径中均未使用，占位即可。
const NO_EVENT = undefined as unknown as IpcMainInvokeEvent;

/** API 仅允许的只读 Agent 指令（与工具注册表 isRun 只读族一致；写工具不在此列）。 */
const READ_ONLY_TOOLS: ReadonlySet<ReviewRunTool> = new Set([
  'describe',
  'review',
  'ask',
  'improve',
]);

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

function seg(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** 列表分页默认页大小（`limit` 缺省 / 非法 / ≤0 时取此值）。 */
const DEFAULT_LIMIT = 100;

/** 当前启用平台下可用的分类标签：`categories`（平台发现分类）+ `statuses`（状态 / 合并态筛选）。 */
const categories: RouteHandler = () => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const built = activeId
    ? ctx.connectionRuntime.adapters.find((a) => a.connectionId === activeId)
    : undefined;
  const caps = built?.adapter.connection.capabilities();
  const categoryList: PrDiscoveryFilter[] = caps?.discoveryFilters
    ? [...caps.discoveryFilters]
    : ['review-requested'];
  return {
    platform: built?.adapter.kind ?? null,
    categories: categoryList,
    statuses: [...PR_SECONDARY_FILTERS],
  };
};

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

/**
 * 触发一次立即轮询刷新（等价 GUI 的手动刷新 / 窗口聚焦刷新）：拉取所有连接的最新 PR、落本地，
 * 返回本轮计数汇总（fetched / changed / added / removed / errors）。复用 GUI 同源 poller.tick
 * （`prs:refresh`）。无远端写副作用（纯读远端 + 落本地），列为安全的开放动作。
 */
const refresh: RouteHandler = () => prCtl.refreshPrs(NO_EVENT, undefined);

/** 服务端（桌面应用）版本，供 CLI `system version` 同时展示客户端 + 服务端版本。 */
const version: RouteHandler = () => ({ version: buildAppInfo(getContext().bootstrap).appVersion });

/**
 * PR 列表：`category`（一级发现分类）+ `status`（二级状态 / 合并态）过滤 + `q` 检索 +
 * `skip`/`limit` 分页（默认 limit 100）。过滤语义复用 @meebox/shared 的纯谓词（与渲染层侧栏同源）；
 * 返回**精简列表投影**（{@link toPrListItem}，去 description 明细、人员仅 slug），此处仅解析参数 + 委派。
 */
const listPrs: RouteHandler = async ({ query }) => {
  const all = await prCtl.listPrs(NO_EVENT, undefined);
  const filtered = filterPullRequests(all, {
    primary: (query.get('category') as PrDiscoveryFilter) || undefined,
    secondary: (query.get('status') as PrSecondaryFilter) || undefined,
    query: query.get('q') ?? undefined,
  });
  const skip = Math.max(0, Number.parseInt(query.get('skip') ?? '', 10) || 0);
  const limitRaw = Number.parseInt(query.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
  return filtered.slice(skip, skip + limit).map(toPrListItem);
};

const showPr: RouteHandler = ({ params }) => getContext().pr.findPrOrThrow(params.id);

const reviewers: RouteHandler = async ({ params }) =>
  (await getContext().pr.findPrOrThrow(params.id)).reviewers;

/** 无 path → 变更文件列表；带 path → 取该文件某一侧（默认 head）内容。 */
const diff: RouteHandler = ({ params, query }) => {
  const path = query.get('path');
  if (path) {
    const side: DiffSide = query.get('side') === 'base' ? 'base' : 'head';
    return prCtl.getFileContent(NO_EVENT, { localId: params.id, side, path });
  }
  return prCtl.listChangedFiles(NO_EVENT, { localId: params.id });
};

const activity: RouteHandler = ({ params }) =>
  prCtl.listActivity(NO_EVENT, { localId: params.id });

const commits: RouteHandler = ({ params }) => prCtl.listCommits(NO_EVENT, { localId: params.id });

const agentStatus: RouteHandler = ({ params }) =>
  agentCtl.getSession(NO_EVENT, { localId: params.id });

const agentHistory: RouteHandler = ({ params }) =>
  agentCtl.getConversation(NO_EVENT, { localId: params.id });

const agentReview: RouteHandler = ({ params }) => agentCtl.runReview(NO_EVENT, { localId: params.id });

/** 发送只读 Agent 指令（describe / review / ask / improve）；写工具硬拒绝（403），无二次确认。 */
const agentInstruct: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { command?: string; args?: string };
  const command = (b.command ?? '').replace(/^\//, '') as ReviewRunTool;
  if (!READ_ONLY_TOOLS.has(command)) {
    throw new HttpError(403, ERROR_CODES.SV_WRITE_NOT_ALLOWED, { command: b.command ?? '' });
  }
  if (command === 'ask' && !b.args?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'ask requires args' });
  }
  return agentCtl.runPragent(NO_EVENT, { localId: params.id, tool: command, question: b.args });
};

/** 发送自然语言聊天（可触发 Agent 任务）：运行中入队、否则起一轮自由规划兜底。 */
const agentChat: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { message?: string };
  if (!b.message?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'message required' });
  }
  return agentCtl.enqueueMessage(NO_EVENT, { localId: params.id, message: b.message });
};

/** 中断该 PR 正在运行的 Agent（思考 / 执行任意阶段即时停）。PR 级停，非按单个工具 run。 */
const agentStop: RouteHandler = ({ params }) =>
  agentCtl.stopAgent(NO_EVENT, { localId: params.id });

/** 该 PR 在运行队列里的 pr-agent runs（active + waiting），供按 run 取消前的发现。 */
const agentRuns: RouteHandler = async ({ params }) => {
  const snapshot = await agentCtl.getQueue(NO_EVENT, undefined);
  return toPrAgentRuns(snapshot, params.id);
};

/** 取消该 PR 的某个 pr-agent run（active SIGKILL / waiting 出队）。先校验 run 归属该 PR。 */
const agentRunCancel: RouteHandler = async ({ params }) => {
  const snapshot = await agentCtl.getQueue(NO_EVENT, undefined);
  const belongs = [...snapshot.active, ...snapshot.waiting].some(
    (r) => r.runId === params.runId && r.prLocalId === params.id,
  );
  if (!belongs) {
    throw new HttpError(404, ERROR_CODES.SV_NOT_FOUND, { runId: params.runId, localId: params.id });
  }
  return agentCtl.cancelPragent(NO_EVENT, { runId: params.runId });
};

/** 评审决断「通过」：先写远端评审状态、再落本地（复用 GUI 同源 setPrStatus）。 */
const approve: RouteHandler = ({ params }) =>
  prCtl.setPrStatus(NO_EVENT, { localId: params.id, status: 'approved' });

/** 评审决断「需修改」：先写远端评审状态、再落本地。 */
const needswork: RouteHandler = ({ params }) =>
  prCtl.setPrStatus(NO_EVENT, { localId: params.id, status: 'needs_work' });

/** 发一条顶层（不锚文件）评论到远端 PR。body.body 为评论正文，空则 400。 */
const comment: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { body?: string };
  if (!b.body?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'comment body required' });
  }
  return prCtl.createComment(NO_EVENT, { localId: params.id, body: b.body });
};

export const routes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/categories'), handler: categories },
  { method: 'GET', segments: seg('/api/v1/whoami'), handler: whoami },
  { method: 'POST', segments: seg('/api/v1/refresh'), handler: refresh },
  { method: 'GET', segments: seg('/api/v1/version'), handler: version },
  { method: 'GET', segments: seg('/api/v1/prs'), handler: listPrs },
  { method: 'GET', segments: seg('/api/v1/prs/:id'), handler: showPr },
  { method: 'GET', segments: seg('/api/v1/prs/:id/diff'), handler: diff },
  { method: 'GET', segments: seg('/api/v1/prs/:id/activity'), handler: activity },
  { method: 'GET', segments: seg('/api/v1/prs/:id/commits'), handler: commits },
  { method: 'GET', segments: seg('/api/v1/prs/:id/reviewers'), handler: reviewers },
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent'), handler: agentStatus },
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent/conversation'), handler: agentHistory },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/review'), handler: agentReview },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/instruct'), handler: agentInstruct },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/chat'), handler: agentChat },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/stop'), handler: agentStop },
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent/runs'), handler: agentRuns },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/runs/:runId/cancel'), handler: agentRunCancel },
  { method: 'POST', segments: seg('/api/v1/prs/:id/approve'), handler: approve },
  { method: 'POST', segments: seg('/api/v1/prs/:id/needswork'), handler: needswork },
  { method: 'POST', segments: seg('/api/v1/prs/:id/comment'), handler: comment },
];

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
