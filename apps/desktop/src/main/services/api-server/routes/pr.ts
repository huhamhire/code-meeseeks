import type { DiffSide } from '@meebox/ipc';
import {
  ERROR_CODES,
  PR_SECONDARY_FILTERS,
  filterPullRequests,
  type PrDiscoveryFilter,
  type PrSecondaryFilter,
} from '@meebox/shared';
import * as prCtl from '../../../controllers/pr.js';
import { getContext } from '../../context.js';
import { HttpError } from '../http.js';
import { toPrListItem } from '../views.js';
import { NO_EVENT, seg, type Route, type RouteHandler } from './shared.js';

/**
 * PR 领域端点：列表 / 详情 / diff / 动态 / 提交 / 评审人（浏览），刷新（refresh）与分类词表（categories），
 * 以及评审写动作（approve / needswork / comment，真实远端写，复用 GUI 同源 controller）。
 * 仍**不**暴露 merge（合并）。写边界见 docs/arch/04-integration/01-service-api.md。
 */

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
 * 触发一次立即轮询刷新（等价 GUI 的手动刷新 / 窗口聚焦刷新）：拉取所有连接的最新 PR、落本地，
 * 返回本轮计数汇总（fetched / changed / added / removed / errors）。复用 GUI 同源 poller.tick
 * （`prs:refresh`）。无远端写副作用（纯读远端 + 落本地），列为安全的开放动作。
 */
const refresh: RouteHandler = () => prCtl.refreshPrs(NO_EVENT, undefined);

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

export const prRoutes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/categories'), handler: categories },
  { method: 'POST', segments: seg('/api/v1/refresh'), handler: refresh },
  { method: 'GET', segments: seg('/api/v1/prs'), handler: listPrs },
  { method: 'GET', segments: seg('/api/v1/prs/:id'), handler: showPr },
  { method: 'GET', segments: seg('/api/v1/prs/:id/diff'), handler: diff },
  { method: 'GET', segments: seg('/api/v1/prs/:id/activity'), handler: activity },
  { method: 'GET', segments: seg('/api/v1/prs/:id/commits'), handler: commits },
  { method: 'GET', segments: seg('/api/v1/prs/:id/reviewers'), handler: reviewers },
  { method: 'POST', segments: seg('/api/v1/prs/:id/approve'), handler: approve },
  { method: 'POST', segments: seg('/api/v1/prs/:id/needswork'), handler: needswork },
  { method: 'POST', segments: seg('/api/v1/prs/:id/comment'), handler: comment },
];
