import {
  createDraft,
  deleteDraft,
  isCommentsCacheStale,
  listDrafts,
  listStoredPullRequests,
  readCommentsCache,
  setLocalStatus,
  updateDraft,
  writeCommentsCache,
} from '@meebox/poller';
import type { RepoIdentity } from '@meebox/repo-mirror';
import type { PrComment } from '@meebox/shared';
import { t } from '../i18n/index.js';
import { annotateOwnership } from '../services/comments.js';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';

/*
 * PR 操作域 controllers：评论 / 列表 / 状态 / 合并 / 镜像 / diff / 草稿
 */

/**
 * 对已有评论发回复，成功后清评论缓存 + 广播 comments:changed 让 UI 重拉。
 */
export const replyComment: IpcController<'comments:reply'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const reply = await adapter.replyToComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.parentCommentId,
    req.body,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
  return reply;
};

/**
 * 删除自己作者的远端评论（带 version 乐观锁）。失败原文抛给 renderer；成功后清缓存 + 广播。
 */
export const deleteComment: IpcController<'comments:delete'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  await adapter.deleteComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.commentId,
    req.version,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
};

/**
 * 编辑自己作者评论 body（带 version 乐观锁）。返回 updated 仅作乐观参考；清缓存 + 广播。
 */
export const editComment: IpcController<'comments:edit'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const updated = await adapter.editComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.commentId,
    req.version,
    req.body,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
  return updated;
};

/**
 * 拉评论内嵌图片（私有实例需带 PAT，renderer 无法直接 fetch）→ 经 main 代理回 dataUrl。不缓存。
 */
export const fetchAttachment: IpcController<'comments:fetchAttachment'> = async (_event, req) => {
  try {
    const ctx = getContext();
    const pr = await ctx.pr.findPrOrThrow(req.localId);
    const adapter = ctx.pr.adapterFor(pr);
    if (!adapter) return null;
    // 传 pr.repo 给 adapter — Bitbucket 的 attachment: 协议需要 repo 上下文拼 URL
    const res = await adapter.getAttachment(req.url, pr.repo);
    if (!res) return null;
    const base64 = Buffer.from(res.bytes).toString('base64');
    return { dataUrl: `data:${res.contentType};base64,${base64}` };
  } catch {
    return null;
  }
};

/**
 * 只展示当前活动连接的 PR（状态库可能仍存切换前其他连接的历史 PR）。
 */
export const listPrs: IpcController<'prs:list'> = async () => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const all = await listStoredPullRequests(ctx.stateStore);
  return activeId ? all.filter((pr) => pr.connectionId === activeId) : all;
};

/**
 * 立即跑一轮 poll。
 */
export const refreshPrs: IpcController<'prs:refresh'> = () => getContext().poller.tick();

/**
 * Poller 最近一次完成时间（启动初始化用）。
 */
export const getLastSync: IpcController<'prs:lastSync'> = () => ({
  at: getContext().poller.getLastPollAt(),
});

/**
 * 设审阅状态：先写远端（失败前端不变），远端 OK 后落本地。
 */
export const setPrStatus: IpcController<'prs:setLocalStatus'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const remoteStatus =
    req.status === 'approved'
      ? 'approved'
      : req.status === 'needs_work'
        ? 'needsWork'
        : 'unapproved';
  await adapter.setPullRequestReviewStatus(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    remoteStatus,
  );
  return setLocalStatus(ctx.stateStore, req.localId, req.status);
};

/**
 * 合并 PR；不在此落本地，靠 renderer refresh → poll 软删收尾，避免本地与远端各执一词。
 */
export const mergePr: IpcController<'prs:merge'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  await adapter.mergePullRequest(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
  );
};

/**
 * 确保 PR 所属 repo 镜像就位（快速路径命中即 noop）。
 */
export const syncRepo: IpcController<'repo:sync'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  return ctx.pr.ensureMirrorReadyForPr(pr);
};

/**
 * 列出 base..head 变更文件（先确保镜像 + 锚到固定 merge-base）。
 */
export const listChangedFiles: IpcController<'diff:listChangedFiles'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  await ctx.pr.ensureMirrorReadyForPr(pr);
  const base = await ctx.pr.resolveDiffBaseSha(pr);
  return ctx.repoMirror.listChangedFiles(id, base, pr.sourceRef.sha);
};

/**
 * 读 base（固定 merge-base）/ head 一侧文件内容。
 */
export const getFileContent: IpcController<'diff:getFileContent'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const sha = req.side === 'base' ? await ctx.pr.resolveDiffBaseSha(pr) : pr.sourceRef.sha;
  return ctx.repoMirror.getFileContent(id, sha, req.path);
};

/**
 * 仅读评论缓存条数（tab 角标懒展示），不打远端。
 */
export const getCommentCountCached: IpcController<'diff:commentCountCached'> = async (
  _event,
  req,
) => {
  const cache = await readCommentsCache(getContext().stateStore, req.localId);
  if (!cache) return null;
  return { count: cache.comments.length };
};

// In-flight dedup: 打开 PR 时多个组件并行调 listComments(force:true)，合并到同一 Promise，远端只打一次。
const listCommentsInFlight = new Map<string, Promise<PrComment[]>>();

/**
 * 拉评论：cache + pr_updated_at stale 比对；force=true 跳缓存。同 localId in-flight 去重。
 */
export const listComments: IpcController<'diff:listComments'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const cache = await readCommentsCache(ctx.stateStore, pr.localId);
  if (!req.force && cache && !isCommentsCacheStale(cache, pr.updatedAt)) {
    return cache.comments;
  }
  const existing = listCommentsInFlight.get(pr.localId);
  if (existing) return existing;
  const adapter = ctx.pr.adapterForOrThrow(pr);
  // dedup 要求把 in-flight Promise **同步**存进 map 后再 await：故显式构造 Promise（内部用 async
  // IIFE 顺序 await）并 set，再 return。不能整体写成顶层 async 函数体内直接 await——首个 await 挂起前
  // Promise 还没注册进 map，落在这窗口内的并发请求就会各自再打一次远端。.finally 绑在 Promise 上做
  // 清理（与具体 await 方无关，成功 / 失败都摘除 map 项）。
  const fetchPromise = (async () => {
    const raw = await adapter.listPullRequestComments(
      { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
      pr.remoteId,
    );
    const fresh = annotateOwnership(raw, adapter);
    await writeCommentsCache(ctx.stateStore, pr.localId, {
      comments: fresh,
      pr_updated_at: pr.updatedAt,
      fetched_at: new Date().toISOString(),
    });
    return fresh;
  })().finally(() => {
    listCommentsInFlight.delete(pr.localId);
  });
  listCommentsInFlight.set(pr.localId, fetchPromise);
  return fetchPromise;
};

/**
 * 拉 commits（不缓存，量少 + 进 commits 标签页才拉）。
 */
export const listCommits: IpcController<'diff:listCommits'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  return adapter.listPullRequestCommits(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
  );
};

/**
 * 本地 git 算 PR 引入提交数（base=targetRef.sha 排除合入的目标提交）；镜像未齐返回 null。
 */
export const getCommitCount: IpcController<'diff:commitCount'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const n = await ctx.repoMirror.countCommits(id, pr.targetRef.sha, pr.sourceRef.sha);
  return n === null ? null : { count: n };
};

/**
 * head 侧 blame；PR 引入行单独返回供 BlameColumn 画色带占位。
 */
export const getBlame: IpcController<'diff:getBlame'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const base = await ctx.pr.resolveDiffBaseSha(pr);
  const [allBlame, changedSet] = await Promise.all([
    ctx.repoMirror.getBlame(id, pr.sourceRef.sha, req.path),
    ctx.repoMirror.listChangedHeadLines(id, base, pr.sourceRef.sha, req.path),
  ]);
  return {
    lines: allBlame.filter((b) => !changedSet.has(b.line)),
    changedLines: Array.from(changedSet).sort((a, b) => a - b),
  };
};

/**
 * 本地所有 repo 镜像总占用字节数（按 host|projectKey|repoSlug 去重）。
 */
export const getTotalSize: IpcController<'repo:getTotalSize'> = async () => {
  const ctx = getContext();
  const prs = await listStoredPullRequests(ctx.stateStore);
  const seen = new Set<string>();
  let total = 0;
  for (const pr of prs) {
    let id: RepoIdentity;
    try {
      id = ctx.pr.repoIdentityFor(pr);
    } catch {
      continue;
    }
    const key = `${id.host}|${id.projectKey}|${id.repoSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await ctx.repoMirror.getSize(id);
    total += r.totalBytes;
  }
  return { totalBytes: total };
};

/**
 * 列某 PR 全部草稿。
 */
export const getDrafts: IpcController<'drafts:list'> = (_event, req) =>
  listDrafts(getContext().stateStore, req.localId);

/**
 * 创建草稿；IPC 边界再挡一道 origin/source 约束避免脏数据进盘。
 */
export const addDraft: IpcController<'drafts:create'> = async (_event, req) => {
  const ctx = getContext();
  const { draft, localId } = req;
  if (draft.origin === 'finding' && !draft.source) {
    throw new Error('drafts:create: origin=finding 必须传 source { runId, findingId }');
  }
  if (draft.origin === 'manual' && draft.source) {
    throw new Error('drafts:create: origin=manual 不应该传 source');
  }
  const created = await createDraft(ctx.stateStore, localId, draft);
  ctx.broadcast('drafts:changed', { localId });
  return created;
};

/**
 * 部分更新草稿（pending 编辑 body 自动转 edited；找不到返回 null）。
 */
export const patchDraft: IpcController<'drafts:update'> = async (_event, req) => {
  const ctx = getContext();
  const updated = await updateDraft(ctx.stateStore, req.localId, req.draftId, req.patch);
  if (updated) ctx.broadcast('drafts:changed', { localId: req.localId });
  return updated;
};

/**
 * 删除草稿。
 */
export const removeDraft: IpcController<'drafts:delete'> = async (_event, req) => {
  const ctx = getContext();
  await deleteDraft(ctx.stateStore, req.localId, req.draftId);
  ctx.broadcast('drafts:changed', { localId: req.localId });
};

/**
 * 批量发布草稿：逐条 publishInlineComment，单条失败不中断；成功即删本地草稿。
 * 整批跑完广播 drafts:changed；有任一成功则 force-refresh 评论 + 广播 comments:changed。
 */
export const publishDraftBatch: IpcController<'drafts:publishBatch'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);

  // 拉一次当前草稿池：localId → id → draft，避免循环里反复 listDrafts 的 O(N²) IO
  const allDrafts = await listDrafts(ctx.stateStore, req.localId);
  const draftById = new Map(allDrafts.map((d) => [d.id, d]));

  const results: { draftId: string; ok: boolean; postedRemoteId?: string; error?: string }[] = [];
  let anyPublished = false;
  for (const draftId of req.draftIds) {
    const draft = draftById.get(draftId);
    if (!draft) {
      results.push({ draftId, ok: false, error: t('drafts.notFound') });
      continue;
    }
    // rejected 不发（用户决断不发）。posted 不守卫：发布成功即删本地草稿，不存历史 posted 态。
    if (draft.status === 'rejected') {
      results.push({ draftId, ok: false, error: t('drafts.rejected') });
      continue;
    }
    try {
      // ReviewDraftAnchor → PrCommentAnchor：side 保守映射 new→added / old→removed；
      // 多行落 endLine（评论出现在标注范围下方，不打断从上往下阅读）。命中 context 行
      // Bitbucket 回 400，错误收进 results 给用户看。
      const posted = await adapter.publishInlineComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        {
          path: draft.anchor.path,
          line: draft.anchor.endLine,
          side: draft.anchor.side,
          lineType: draft.anchor.side === 'old' ? 'removed' : 'added',
        },
        draft.body,
      );
      // 发布成功 = 本地草稿使命完成，直接删掉（远端评论由下面 force-refresh 拉回承接显示）。
      await deleteDraft(ctx.stateStore, req.localId, draftId);
      anyPublished = true;
      results.push({ draftId, ok: true, postedRemoteId: posted.remoteId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn(
        { localId: req.localId, draftId, err: msg },
        'drafts:publishBatch: single draft failed',
      );
      results.push({ draftId, ok: false, error: msg });
    }
  }

  ctx.broadcast('drafts:changed', { localId: req.localId });
  if (anyPublished) {
    await ctx.pr.invalidateCommentsCache(pr.localId);
  }
  return { results };
};
