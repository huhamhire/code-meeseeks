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
import { getContext } from '../context.js';
import { HttpError } from './http.js';
import { toPrListItem } from './views.js';

/**
 * 本地 API 的路由表与处理器。处理器**复用 IPC controller 同源逻辑**——controller 形态为
 * `(event, req)` 且只读路径不触碰 event，故以 NO_EVENT 占位调用，避免在 HTTP 侧另起一套实现。
 * 只读边界：写工具一律不暴露（见 agent/instruct）。见 docs/arch/04-integration/01-service-api.md。
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

export const routes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/categories'), handler: categories },
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
