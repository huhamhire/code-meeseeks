import { ipcMain } from 'electron';
import type { IpcChannels } from '@meebox/ipc';
import {
  clearAgentSession,
  clearAutopilotLedger,
  clearReviewRunsForPr,
  createDraft,
  deleteDraft,
  getReviewRun,
  isCommentsCacheStale,
  listDrafts,
  listReviewRunsForPr,
  listStoredPullRequests,
  readCommentsCache,
  setLocalStatus,
  updateDraft,
  writeCommentsCache,
} from '@meebox/poller';
import type { RepoIdentity } from '@meebox/repo-mirror';
import type { PlatformAdapter, PrComment } from '@meebox/shared';
import { t } from '../../i18n/index.js';
import type { IpcContext } from '../context.js';
import type { RunQueueService } from '../run-queue.js';

/** PR 操作域：评论 / 列表 / 状态 / 合并 / 镜像 / diff / 草稿 / pr-agent run 队列。 */
export function registerPrHandlers(ctx: IpcContext, runQueue: RunQueueService): void {
  const {
    bootstrap,
    logger,
    stateStore,
    poller,
    repoMirror,
    getPrAgentBridge,
    broadcast,
    findPrOrThrow,
    repoIdentityFor,
    adapterFor,
    adapterForOrThrow,
    ensureMirrorReadyForPr,
    resolveDiffBaseSha,
    invalidateCommentsCache,
  } = ctx;

  const broadcastDraftsChanged = (localId: string): void => broadcast('drafts:changed', { localId });

  // ── 评论 ──

  ipcMain.handle(
    'comments:reply',
    async (
      _evt,
      req: IpcChannels['comments:reply']['request'],
    ): Promise<IpcChannels['comments:reply']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      const reply = await adapter.replyToComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        req.parentCommentId,
        req.body,
      );
      // 清掉 comments cache，下次 listComments 会 force 拉远端拿到最新评论树
      // (包括刚 post 的 reply 嵌入到正确父评论 .replies 数组)。同时广播事件让
      // CommentsPanel / DiffView 自动重拉
      await invalidateCommentsCache(pr.localId);
      return reply;
    },
  );

  ipcMain.handle(
    'comments:delete',
    async (
      _evt,
      req: IpcChannels['comments:delete']['request'],
    ): Promise<IpcChannels['comments:delete']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      // Bitbucket 在以下情形 409/403：
      //   - version 跟远端不一致 (用户在别处已编辑)
      //   - 评论已有回复 (跟 web UI 同步规则)
      //   - 当前 PAT 不是作者本人
      // 错误体已经在 BitbucketClientError.message 里带，直接抛给 renderer 显示原文
      await adapter.deleteComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        req.commentId,
        req.version,
      );
      // 跟 reply 同套：清 cache + 广播让 UI 立刻看到评论消失
      await invalidateCommentsCache(pr.localId);
    },
  );

  ipcMain.handle(
    'comments:edit',
    async (
      _evt,
      req: IpcChannels['comments:edit']['request'],
    ): Promise<IpcChannels['comments:edit']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      // Bitbucket 409 (version 不一致) 时 BitbucketClientError.message 会带 "expected version X"
      // 这种细节，原样抛给 renderer 显示让用户知道"远端有新版本"
      const updated = await adapter.editComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        req.commentId,
        req.version,
        req.body,
      );
      // 清 cache + 广播，UI 重拉刷新 (跟 delete 同套链路)。返回 updated 仅作
      // 调用方乐观参考 — 实际页面渲染走 cache→force-refresh 路径
      await invalidateCommentsCache(pr.localId);
      return updated;
    },
  );

  ipcMain.handle(
    'comments:fetchAttachment',
    async (
      _evt,
      req: IpcChannels['comments:fetchAttachment']['request'],
    ): Promise<IpcChannels['comments:fetchAttachment']['response']> => {
      // 找 PR 对应的 connection adapter 拉 attachment。不缓存 — 评论图片重复
      // 加载概率低 (用户决策)，每次进入 PR 走 IPC 跟头像走 cache 不同
      try {
        const pr = await findPrOrThrow(req.localId);
        const adapter = adapterFor(pr);
        if (!adapter) return null;
        // 传 pr.repo 给 adapter — Bitbucket 的 attachment: 协议需要 repo 上下文拼 URL
        const res = await adapter.getAttachment(req.url, pr.repo);
        if (!res) return null;
        const base64 = Buffer.from(res.bytes).toString('base64');
        return { dataUrl: `data:${res.contentType};base64,${base64}` };
      } catch {
        return null;
      }
    },
  );

  // ── PR 列表 / 状态 / 合并 ──

  ipcMain.handle('prs:list', async (): Promise<IpcChannels['prs:list']['response']> => {
    // 单活动连接模型：只展示当前活动连接的 PR。状态库可能仍存着切换前其他连接的
    // 历史 PR（poller 只轮询活动连接，不会清理旧的），故在出口按 connectionId 过滤。
    const activeId = bootstrap.config.active_connection_id;
    const all = await listStoredPullRequests(stateStore);
    return activeId ? all.filter((pr) => pr.connectionId === activeId) : all;
  });
  ipcMain.handle(
    'prs:refresh',
    async (): Promise<IpcChannels['prs:refresh']['response']> => poller.tick(),
  );
  ipcMain.handle('prs:lastSync', (): IpcChannels['prs:lastSync']['response'] => ({
    at: poller.getLastPollAt(),
  }));
  ipcMain.handle(
    'prs:setLocalStatus',
    async (
      _evt,
      req: IpcChannels['prs:setLocalStatus']['request'],
    ): Promise<IpcChannels['prs:setLocalStatus']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      // 先写远端：本地 status → Bitbucket reviewer.status；失败抛出，前端不会看到本地变更
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
      // 远端 OK 后落本地，UI 立即反映；下一轮 poll 会取回相同值
      return setLocalStatus(stateStore, req.localId, req.status);
    },
  );

  ipcMain.handle(
    'prs:merge',
    async (_evt, req: IpcChannels['prs:merge']['request']): Promise<void> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      // 合并远端；失败 (冲突 / veto / 权限) 抛出，renderer 提示，本地不变。
      // 成功后不在此落本地：PR 转 MERGED 会从 pending 消失，靠 renderer 触发的
      // refresh → poll 软删收尾，避免本地状态与远端各执一词
      await adapter.mergePullRequest(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
      );
    },
  );

  // ── 镜像 / diff ──

  ipcMain.handle(
    'repo:sync',
    async (
      _evt,
      req: IpcChannels['repo:sync']['request'],
    ): Promise<IpcChannels['repo:sync']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      return ensureMirrorReadyForPr(pr);
    },
  );

  ipcMain.handle(
    'diff:listChangedFiles',
    async (
      _evt,
      req: IpcChannels['diff:listChangedFiles']['request'],
    ): Promise<IpcChannels['diff:listChangedFiles']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const id = repoIdentityFor(pr);
      // 自动确保 mirror 含 head + base sha (快速路径命中即 noop)；再算 diff
      await ensureMirrorReadyForPr(pr);
      // base 锚到固定 merge-base（非漂移的 targetRef.sha），三点 diff 对目标分支前移稳定
      const base = await resolveDiffBaseSha(pr);
      return repoMirror.listChangedFiles(id, base, pr.sourceRef.sha);
    },
  );

  ipcMain.handle(
    'diff:getFileContent',
    async (
      _evt,
      req: IpcChannels['diff:getFileContent']['request'],
    ): Promise<IpcChannels['diff:getFileContent']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const id = repoIdentityFor(pr);
      // base 侧读固定 merge-base 的内容（与三点 diff 一致），head 侧读源 tip
      const sha = req.side === 'base' ? await resolveDiffBaseSha(pr) : pr.sourceRef.sha;
      return repoMirror.getFileContent(id, sha, req.path);
    },
  );

  ipcMain.handle(
    'diff:commentCountCached',
    async (
      _evt,
      req: IpcChannels['diff:commentCountCached']['request'],
    ): Promise<IpcChannels['diff:commentCountCached']['response']> => {
      const cache = await readCommentsCache(stateStore, req.localId);
      if (!cache) return null;
      return { count: cache.comments.length };
    },
  );

  // In-flight dedup: 打开 PR 时 MainPane / DiffView / CommentsPanel 三个组件
  // 并行调 listComments(force:true)，没去重的话会打 3 次 Bitbucket API。同一 localId
  // 的 concurrent 调用合并到同一个 Promise，远端只打一次
  const listCommentsInFlight = new Map<string, Promise<PrComment[]>>();
  ipcMain.handle(
    'diff:listComments',
    async (
      _evt,
      req: IpcChannels['diff:listComments']['request'],
    ): Promise<IpcChannels['diff:listComments']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      // 缓存命中条件：pr_updated_at 跟当前 PR meta updatedAt 一致 → 直接回缓存，
      // 不打远端。PR 任何变更 (新评论 / 状态等) Bitbucket 都会更新 updatedAt，跳变即重拉。
      //
      // **req.force=true** 跳过 cache 直接打远端 — 本地 PR.updatedAt 来自 poller
      // 周期拉，可能滞后，stale 比对会误判命中。打开 PR 时 renderer 传 force=true
      // 强制刷新，确保拿到最新评论
      const cache = await readCommentsCache(stateStore, pr.localId);
      if (!req.force && cache && !isCommentsCacheStale(cache, pr.updatedAt)) {
        return cache.comments;
      }
      // dedup：同 localId 的 in-flight Promise 直接复用
      const existing = listCommentsInFlight.get(pr.localId);
      if (existing) return existing;
      const adapter = adapterForOrThrow(pr);
      const fetchPromise = adapter
        .listPullRequestComments(
          { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
          pr.remoteId,
        )
        .then((raw) => annotateOwnership(raw, adapter))
        .then(async (fresh) => {
          await writeCommentsCache(stateStore, pr.localId, {
            comments: fresh,
            pr_updated_at: pr.updatedAt,
            fetched_at: new Date().toISOString(),
          });
          return fresh;
        })
        .finally(() => {
          listCommentsInFlight.delete(pr.localId);
        });
      listCommentsInFlight.set(pr.localId, fetchPromise);
      return fetchPromise;
    },
  );

  ipcMain.handle(
    'diff:listCommits',
    async (
      _evt,
      req: IpcChannels['diff:listCommits']['request'],
    ): Promise<IpcChannels['diff:listCommits']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);
      // commits 不缓存（量少 + UI 进 commits 标签页才拉，频率低）；后续如发现频繁拉
      // 再补 prs/<hash>/commits.json 缓存层 (走 pr_updated_at 失效，跟 comments 同模式)
      return adapter.listPullRequestCommits(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
      );
    },
  );

  ipcMain.handle(
    'diff:commitCount',
    async (
      _evt,
      req: IpcChannels['diff:commitCount']['request'],
    ): Promise<IpcChannels['diff:commitCount']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const id = repoIdentityFor(pr);
      // 本地 git 算提交数；不打远端、不主动触发 sync。镜像还没拉齐就返回 null，
      // UI 角标暂不显示，等下次 poll 触发 syncMirror 完成后自然命中。
      // 口径 = PR 自身提交（源分支「不在目标分支上」的非 merge 提交），对齐平台 /commits 列表。
      // **基准用目标分支 sha（head ^target）而非固定 merge-base**：源分支把目标分支（如 dev）合入自己后，
      // merge-base 之后被带进来的目标提交也可达 head、不可达 merge-base → 用 merge-base 会把它们误计
      // （标 31 实则 2）。以 targetRef.sha 排除这些合入提交；merge 提交本身由 countCommits 的 --no-merges 略去。
      // （diff 仍用固定 merge-base 保稳定，与本计数口径各司其职。）
      const n = await repoMirror.countCommits(id, pr.targetRef.sha, pr.sourceRef.sha);
      return n === null ? null : { count: n };
    },
  );

  ipcMain.handle(
    'diff:getBlame',
    async (
      _evt,
      req: IpcChannels['diff:getBlame']['request'],
    ): Promise<IpcChannels['diff:getBlame']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const id = repoIdentityFor(pr);
      // 只对 base 已有部分展示 blame；PR 引入的行单独返给 renderer，
      // 由 BlameColumn 画色带占位（对应 Monaco diff 添加/修改区的视觉）。
      const base = await resolveDiffBaseSha(pr);
      const [allBlame, changedSet] = await Promise.all([
        repoMirror.getBlame(id, pr.sourceRef.sha, req.path),
        repoMirror.listChangedHeadLines(id, base, pr.sourceRef.sha, req.path),
      ]);
      return {
        lines: allBlame.filter((b) => !changedSet.has(b.line)),
        changedLines: Array.from(changedSet).sort((a, b) => a - b),
      };
    },
  );

  ipcMain.handle('repo:getTotalSize', async (): Promise<{ totalBytes: number }> => {
    const prs = await listStoredPullRequests(stateStore);
    const seen = new Set<string>();
    let total = 0;
    for (const pr of prs) {
      let id: RepoIdentity;
      try {
        id = repoIdentityFor(pr);
      } catch {
        continue;
      }
      const key = `${id.host}|${id.projectKey}|${id.repoSlug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await repoMirror.getSize(id);
      total += r.totalBytes;
    }
    return { totalBytes: total };
  });

  // ── pr-agent run 队列 ──

  ipcMain.handle(
    'pragent:run',
    async (
      _evt,
      req: IpcChannels['pragent:run']['request'],
    ): Promise<IpcChannels['pragent:run']['response']> => {
      if (!getPrAgentBridge()) {
        throw new Error(t('prAgent.notReadyDetail'));
      }
      // 早期校验：/ask 必须带 question，避免排队后才报错
      if (req.tool === 'ask' && !req.question?.trim()) {
        throw new Error(t('prAgent.askNeedsQuestion'));
      }
      const pr = await findPrOrThrow(req.localId);
      return runQueue.enqueuePragentRun(pr, req.tool, req.question);
    },
  );

  ipcMain.handle(
    'pragent:cancel',
    (_evt, req: IpcChannels['pragent:cancel']['request']): IpcChannels['pragent:cancel']['response'] =>
      runQueue.cancel(req.runId),
  );

  ipcMain.handle('pragent:queue', (): IpcChannels['pragent:queue']['response'] => runQueue.snapshot());

  ipcMain.handle(
    'pragent:listRuns',
    async (
      _evt,
      req: IpcChannels['pragent:listRuns']['request'],
    ): Promise<IpcChannels['pragent:listRuns']['response']> =>
      listReviewRunsForPr(stateStore, req.localId, {
        limit: req.limit,
        beforeId: req.beforeId,
      }),
  );

  ipcMain.handle(
    'pragent:getRun',
    async (
      _evt,
      req: IpcChannels['pragent:getRun']['request'],
    ): Promise<IpcChannels['pragent:getRun']['response']> =>
      getReviewRun(stateStore, req.localId, req.runId),
  );

  ipcMain.handle(
    'pragent:clearRuns',
    async (
      _evt,
      req: IpcChannels['pragent:clearRuns']['request'],
    ): Promise<IpcChannels['pragent:clearRuns']['response']> => {
      // 清执行历史时一并清掉 Agent 会话（含收尾 summary / 步骤 transcript），否则清空后
      // 重开 PR 仍会从落盘会话恢复出「评审总结」卡片。
      await clearAgentSession(stateStore, req.localId);
      // 一并清掉 AutoPilot 台账（评审建议 verdict），并广播 → PR 列表该 PR 的 ★ 徽标即时消失，
      // 不残留陈旧评审状态、也不必等下个 poll 重取台账。
      await clearAutopilotLedger(stateStore, req.localId);
      broadcast('agent:reviewStatusCleared', { prLocalId: req.localId });
      return { cleared: await clearReviewRunsForPr(stateStore, req.localId) };
    },
  );

  // ── M4 草稿 ──
  // 所有 mutator (create / update / delete) 写盘成功后立刻广播 drafts:changed，
  // renderer drafts-store 据此重拉刷新

  ipcMain.handle(
    'drafts:list',
    async (
      _evt,
      req: IpcChannels['drafts:list']['request'],
    ): Promise<IpcChannels['drafts:list']['response']> => listDrafts(stateStore, req.localId),
  );

  ipcMain.handle(
    'drafts:create',
    async (
      _evt,
      req: IpcChannels['drafts:create']['request'],
    ): Promise<IpcChannels['drafts:create']['response']> => {
      // 防御：origin='finding' 必须带 source；origin='manual' 不要 source。
      // 上层 UI 已校验，但 IPC 边界再挡一道避免脏数据进盘
      const { draft, localId } = req;
      if (draft.origin === 'finding' && !draft.source) {
        throw new Error('drafts:create: origin=finding 必须传 source { runId, findingId }');
      }
      if (draft.origin === 'manual' && draft.source) {
        throw new Error('drafts:create: origin=manual 不应该传 source');
      }
      const created = await createDraft(stateStore, localId, draft);
      broadcastDraftsChanged(localId);
      return created;
    },
  );

  ipcMain.handle(
    'drafts:update',
    async (
      _evt,
      req: IpcChannels['drafts:update']['request'],
    ): Promise<IpcChannels['drafts:update']['response']> => {
      const updated = await updateDraft(stateStore, req.localId, req.draftId, req.patch);
      if (updated) broadcastDraftsChanged(req.localId);
      return updated;
    },
  );

  ipcMain.handle(
    'drafts:delete',
    async (
      _evt,
      req: IpcChannels['drafts:delete']['request'],
    ): Promise<IpcChannels['drafts:delete']['response']> => {
      await deleteDraft(stateStore, req.localId, req.draftId);
      broadcastDraftsChanged(req.localId);
    },
  );

  ipcMain.handle(
    'drafts:publishBatch',
    async (
      _evt,
      req: IpcChannels['drafts:publishBatch']['request'],
    ): Promise<IpcChannels['drafts:publishBatch']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapterForOrThrow(pr);

      // 拉一次当前草稿池：localId → id → draft，下面遍历 draftIds 时按 id 查。
      // 不在循环里反复 listDrafts，避免 PR 草稿量大时 O(N²) IO
      const allDrafts = await listDrafts(stateStore, req.localId);
      const draftById = new Map(allDrafts.map((d) => [d.id, d]));

      const results: IpcChannels['drafts:publishBatch']['response']['results'] = [];
      let anyPublished = false;
      for (const draftId of req.draftIds) {
        const draft = draftById.get(draftId);
        if (!draft) {
          results.push({ draftId, ok: false, error: t('drafts.notFound') });
          continue;
        }
        // 状态守卫：rejected 不发 (用户决断不发)。
        // posted 不再守卫 — 发布成功后本地草稿直接删除，不存 'posted' 历史状态，
        // 调用方传过来的 draftId 在 listDrafts 找不到时已经被前面 `if (!draft)` 兜住
        if (draft.status === 'rejected') {
          results.push({ draftId, ok: false, error: t('drafts.rejected') });
          continue;
        }
        try {
          // ReviewDraftAnchor → PrCommentAnchor 转换：
          // - draft.anchor 没有 lineType (草稿创建时不知道这一行的 diff 角色)，
          //   按 side 做保守映射：new→added / old→removed。meebox 的草稿大多锚到
          //   变更行 (finding 来自 /review 的 issue + DraftZone hover '+' 也只对
          //   变更行可见)，context 行评论场景极少。命中 context 时 Bitbucket 回 400，
          //   错误会被 catch 收到 results 里给用户看
          // - 多行 (endLine > startLine) 在 Bitbucket REST 里无法表达 (anchor.line 是单
          //   行)。落到 endLine 而不是 startLine：评论会出现在标注范围**下方**，
          //   不打断用户从上往下阅读时已经看过的代码上下文。renderer 端 DraftZone
          //   仍按 startLine 渲染 (跟 finding/AI 建议触发位置一致)，发布完远端
          //   评论会自然显示在 endLine —— 这两种位置都不影响"阅读上下文" 的初衷
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
          // 发布成功 = 本地草稿使命完成，直接删掉保持草稿池干净。远端 Bitbucket 评论
          // 会通过下面的 force-refresh comments 拉回，UI 上由 CommentZone 承接显示，
          // 不需要本地再留一份 'posted' 副本造成重复 (跟远端评论 zone 视觉打架)
          await deleteDraft(stateStore, req.localId, draftId);
          anyPublished = true;
          results.push({ draftId, ok: true, postedRemoteId: posted.remoteId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn(
            { localId: req.localId, draftId, err: msg },
            'drafts:publishBatch: single draft failed',
          );
          results.push({ draftId, ok: false, error: msg });
        }
      }

      // 整批跑完统一广播 — drafts 列表更新刷 DraftZone status chip + FindingCard
      broadcastDraftsChanged(req.localId);

      // 至少有一条发成功 → force-refresh Bitbucket 评论：清缓存 + 广播 comments:changed
      // 让 CommentsPanel / DiffView 内嵌评论立即看到自己刚发的，不用等下一轮 poller
      if (anyPublished) {
        await invalidateCommentsCache(pr.localId);
      }
      return { results };
    },
  );
}

/**
 * 给每条评论 (含 replies 子树) 打 canDelete / canEdit 标志。
 *
 * - canDelete: author.name === 当前 PAT 用户 && 无 reply && 有 version
 *   (Bitbucket 拒删带 reply 的；DELETE 必带 version 乐观锁)
 * - canEdit:   author.name === 当前 PAT 用户 && 有 version
 *   (Bitbucket 允许编辑带 reply 的评论；PUT 也带 version)
 *
 * 当前用户拿不到 (ping 未完成 / 失败) → 全部 false。renderer 直读 flag 不再
 * 自己比对 author / version / replies，链路最短最稳。
 */
function annotateOwnership(comments: PrComment[], adapter: PlatformAdapter): PrComment[] {
  const me = adapter.getCurrentUser();
  if (!me) {
    return setOwnershipRecursive(comments, () => ({ canDelete: false, canEdit: false }));
  }
  // 「带 reply 的评论不可删」是 Bitbucket 限制（删父评论会孤立子评论）；GitHub / GitLab 允许删
  // 自己的评论（含有 reply 的）。用乐观锁能力位作 Bitbucket 代理。
  const noDeleteWithReplies = adapter.capabilities().commentOptimisticLock;
  return setOwnershipRecursive(comments, (c) => {
    const isMine = c.author.name === me.name;
    const hasVersion = typeof c.version === 'number';
    return {
      canDelete: isMine && hasVersion && (!noDeleteWithReplies || c.replies.length === 0),
      canEdit: isMine && hasVersion,
    };
  });
}

function setOwnershipRecursive(
  comments: PrComment[],
  judge: (c: PrComment) => { canDelete: boolean; canEdit: boolean },
): PrComment[] {
  return comments.map((c) => {
    const flags = judge(c);
    return {
      ...c,
      canDelete: flags.canDelete,
      canEdit: flags.canEdit,
      replies: setOwnershipRecursive(c.replies, judge),
    };
  });
}
