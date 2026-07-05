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
 * PR domain endpoints: list / detail / diff / activity / commits / reviewers (browsing), refresh and
 * category vocabulary (categories), plus review write actions (approve / needswork / comment, real remote
 * writes, reusing the GUI's same-source controller). Still does **not** expose merge. Write boundary see
 * docs/arch/04-integration/01-service-api.md.
 */

/** List pagination default page size (used when `limit` is missing / invalid / ≤0). */
const DEFAULT_LIMIT = 100;

/** Category labels available under the currently active platform: `categories` (platform discovery filters) + `statuses` (status / merge-state filters). */
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
 * Trigger an immediate polling refresh (equivalent to the GUI's manual refresh / window-focus refresh):
 * fetch the latest PRs across all connections, persist locally, and return this round's count summary
 * (fetched / changed / added / removed / errors). Reuses the GUI's same-source poller.tick
 * (`prs:refresh`). No remote write side effects (pure remote read + local persist), listed as a safe open action.
 */
const refresh: RouteHandler = () => prCtl.refreshPrs(NO_EVENT, undefined);

/**
 * PR list: `category` (primary discovery filter) + `status` (secondary status / merge-state) filtering + `q`
 * search + `skip`/`limit` pagination (default limit 100). Filter semantics reuse @meebox/shared's pure
 * predicates (same source as the renderer sidebar); returns a **compact list projection** ({@link toPrListItem},
 * drops description detail, people as slug only). Here only parses params + delegates.
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

/** No path → changed file list; with path → get that file's content on one side (default head). */
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

/** Review verdict "approve": write the remote review status first, then persist locally (reuses the GUI's same-source setPrStatus). */
const approve: RouteHandler = ({ params }) =>
  prCtl.setPrStatus(NO_EVENT, { localId: params.id, status: 'approved' });

/** Review verdict "needs work": write the remote review status first, then persist locally. */
const needswork: RouteHandler = ({ params }) =>
  prCtl.setPrStatus(NO_EVENT, { localId: params.id, status: 'needs_work' });

/** Post a top-level (not file-anchored) comment to the remote PR. body.body is the comment text; empty → 400. */
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
