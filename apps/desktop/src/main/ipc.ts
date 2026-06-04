import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { writeConfig, type BootstrapResult } from '@pr-pilot/config';
import { PrAgentRunError, type PrAgentBridge } from '@pr-pilot/pr-agent-bridge';
import {
  type Poller,
  createDraft,
  deleteDraft,
  dropPendingFindingDrafts,
  finishReviewRun,
  getReviewRun,
  isCommentsCacheStale,
  listDrafts,
  listReviewRunsForPr,
  listStoredPullRequests,
  makeRunId,
  parseReviewOutput,
  readCommentsCache,
  setLocalStatus,
  startReviewRun,
  updateDraft,
  writeCommentsCache,
} from '@pr-pilot/poller';
import type { RepoIdentity, RepoMirrorManager } from '@pr-pilot/repo-mirror';
import { loadRules, pickMatchingRule } from '@pr-pilot/rules';
import type {
  AppInfo,
  ConnectionSummary,
  IpcChannels,
  PlatformAdapter,
  PrAgentStatus,
  PrComment,
  PragentRunInfo,
  ReviewRun,
  ReviewRunStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@pr-pilot/shared';
import type { JsonFileStateStore } from '@pr-pilot/state-store';
import type { BuiltAdapter } from './adapters.js';
import { sniffImageContentType } from './utils/image.js';
import { buildPragentEnv, resolveActiveLlmProfile } from './utils/agent.js';
import { buildPrContext } from './utils/pr-context.js';

interface RegisterDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
  prAgentStatus: PrAgentStatus;
  /** 探测可用时的 bridge 实例；不可用 (embedded / CLI / Docker 都没有) 为 null */
  prAgentBridge: PrAgentBridge | null;
  /** 嵌入式运行时解释器路径（embedded 策略下执行期补 .secrets.toml 用），非 embedded 可空 */
  embeddedPythonPath?: string;
  stateStore: JsonFileStateStore;
  poller: Poller;
  adapters: readonly BuiltAdapter[];
  repoMirror: RepoMirrorManager;
}

/**
 * 注册全部 IPC handler。后续新增 channel 时只需扩 IpcChannels + 在此添加一个 handle。
 * 故意保持显式，每个 channel 一行映射，方便审计 main↔renderer 暴露面。
 */
export function registerIpcHandlers({
  bootstrap,
  logger,
  prAgentStatus,
  prAgentBridge,
  embeddedPythonPath,
  stateStore,
  poller,
  adapters,
  repoMirror,
}: RegisterDeps): void {
  // === pr-agent run 队列 ===
  //
  // FIFO 队列，同时只有 1 条在跑 (避免撞 LLM rate limit / 抢 docker / 抢 worktree)，
  // 其余在 waiting 排队。每次 active 完成 / 取消 → 自动开下一条。
  //
  // 设计要点：
  //   - runId 在入队时就分配 (跟最终落盘 ReviewRun.id 一致)，cancel(runId) 在
  //     active / waiting 两种状态都能精确定位
  //   - queued 状态不落盘；被取消时直接 reject 原 Promise，不留 disk artifact
  //   - 真正 dequeue 才 startReviewRun 写 disk + 跑 pr-agent
  //   - 每次队列变化广播 'pragent:queueChanged'，renderer store 同步
  interface QueueItem {
    info: PragentRunInfo;
    req: { localId: string; tool: ReviewRunTool; question?: string };
    pr: StoredPullRequest;
    resolve: (run: ReviewRun) => void;
    reject: (err: Error) => void;
    /** 仅 active 状态填；用于 cancel SIGKILL */
    ac?: AbortController;
  }
  const waiting: QueueItem[] = [];
  let active: QueueItem | null = null;

  const broadcastQueueChanged = (): void => {
    const payload = {
      active: active?.info ?? null,
      waiting: waiting.map((q) => q.info),
    };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pragent:queueChanged', payload);
    }
  };

  /** 草稿变更广播：drafts:* IPC 写盘后调用，告诉 renderer 重拉某 PR 的草稿列表 */
  const broadcastDraftsChanged = (localId: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('drafts:changed', { localId });
    }
  };

  const findPrOrThrow = async (localId: string): Promise<StoredPullRequest> => {
    const prs = await listStoredPullRequests(stateStore);
    const pr = prs.find((p) => p.localId === localId);
    if (!pr) throw new Error(`PR not found in local state: ${localId}`);
    return pr;
  };

  // /ask 输出去重：pr-agent answer markdown 里会回显完整问题，跟 UI chat-user-msg
  // 气泡重复。逐行精确匹配 question (含 trim 后) 的行整行删掉，保留其余正文
  const stripAskQuestionEcho = (md: string, question: string): string => {
    const q = question.trim();
    if (!q || !md) return md;
    return md
      .split('\n')
      .filter((line) => line.trim() !== q)
      .join('\n');
  };

  // pr-agent docker 镜像启动时会去找 `/app/pr_agent/settings/.secrets.toml` 和
  // `/app/pr_agent/settings_prod/.secrets.toml`，没有就 WARNING。我们走 env 传密钥
  // 不用 secrets.toml，但每次 run 都打两条 WARNING 很烦。挂个空文件压掉
  const ensureEmptySecretsFile = async (): Promise<string> => {
    const p = path.join(bootstrap.paths.cacheDir, 'pr-agent-empty-secrets.toml');
    try {
      await fs.access(p);
    } catch {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(
        p,
        '# pr-pilot 提供的空 secrets 文件，抑制 pr-agent 启动 "settings file not found" 告警\n',
      );
    }
    return p;
  };

  // embedded 策略：执行期在嵌入式安装目录的 settings/ 与 settings_prod/ 补空
  // .secrets.toml（同 Docker 挂空文件的意图，只是没有容器、直接写安装目录）。
  // memo 化：只在首个 embedded run 解析一次 pr_agent 目录 + 写文件，后续直接复用。
  // importlib.util.find_spec 仅定位不 import pr_agent，快；失败仅 warn 不阻断 run。
  const execFileP = promisify(execFile);
  let embeddedSecretsEnsured: Promise<void> | null = null;
  const ensureEmbeddedSecrets = (pythonPath: string): Promise<void> => {
    embeddedSecretsEnsured ??= (async () => {
      const { stdout } = await execFileP(pythonPath, [
        '-c',
        "import importlib.util,os;print(os.path.dirname(importlib.util.find_spec('pr_agent').origin))",
      ]);
      const prAgentDir = stdout.trim();
      for (const sub of ['settings', 'settings_prod']) {
        const dir = path.join(prAgentDir, sub);
        await fs.mkdir(dir, { recursive: true });
        const f = path.join(dir, '.secrets.toml');
        try {
          await fs.access(f);
        } catch {
          await fs.writeFile(
            f,
            '# pr-pilot 占位空文件：抑制 pr-agent 缺失 .secrets.toml 的启动告警\n',
          );
        }
      }
    })().catch((err: unknown) => {
      logger.warn({ err }, 'ensure embedded .secrets.toml failed (ignored)');
    });
    return embeddedSecretsEnsured;
  };

  const repoIdentityFor = (pr: StoredPullRequest): RepoIdentity => {
    const conn = bootstrap.config.connections.find((c) => c.id === pr.connectionId);
    if (!conn) throw new Error(`connection not found: ${pr.connectionId}`);
    return {
      host: new URL(conn.base_url).hostname,
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
    };
  };

  ipcMain.handle('app:info', (): IpcChannels['app:info']['response'] => buildAppInfo(bootstrap));
  ipcMain.handle('app:paths', (): IpcChannels['app:paths']['response'] => bootstrap.paths);
  ipcMain.handle(
    'app:prAgentStatus',
    (): IpcChannels['app:prAgentStatus']['response'] => prAgentStatus,
  );
  ipcMain.handle(
    'app:connections',
    (): IpcChannels['app:connections']['response'] => buildConnectionSummaries(bootstrap, adapters),
  );

  // (connectionId, slug) → dataUrl 或 null。两级 cache：
  //   1) avatarMem: 进程内 Map，本会话内瞬时返回（含 null 负缓存避免重试失败 slug）
  //   2) 磁盘文件 <cacheDir>/avatars/<hash>.bin，TTL 7 天，按 mtime 判定过期
  //      过期或不存在 → 重新打 BBS → 写回磁盘
  // hash = sha256(connectionId|slug) 前 24 hex，纯字母数字文件名安全
  const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const avatarDir = path.join(bootstrap.paths.cacheDir, 'avatars');
  const avatarMem = new Map<string, { dataUrl: string } | null>();

  ipcMain.handle(
    'comments:reply',
    async (
      _evt,
      req: IpcChannels['comments:reply']['request'],
    ): Promise<IpcChannels['comments:reply']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      const reply = await adapter.replyToComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        req.parentCommentId,
        req.body,
      );
      // 清掉 comments cache，下次 listComments 会 force 拉远端拿到最新评论树
      // (包括刚 post 的 reply 嵌入到正确父评论 .replies 数组)。同时广播事件让
      // CommentsPanel / DiffView 自动重拉
      try {
        await stateStore.delete(`prs/${pr.localId}/comments`);
      } catch {
        /* cache miss 也无所谓 */
      }
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('comments:changed', { localId: pr.localId });
      }
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
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      // BBS 在以下情形 409/403：
      //   - version 跟远端不一致 (用户在别处已编辑)
      //   - 评论已有回复 (跟 web UI 同步规则)
      //   - 当前 PAT 不是作者本人
      // 错误体已经在 BBClientError.message 里带，直接抛给 renderer 显示原文
      await adapter.deleteComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        req.commentId,
        req.version,
      );
      // 跟 reply 同套：清 cache + 广播让 UI 立刻看到评论消失
      try {
        await stateStore.delete(`prs/${pr.localId}/comments`);
      } catch {
        /* cache miss 也无所谓 */
      }
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('comments:changed', { localId: pr.localId });
      }
    },
  );

  ipcMain.handle(
    'comments:edit',
    async (
      _evt,
      req: IpcChannels['comments:edit']['request'],
    ): Promise<IpcChannels['comments:edit']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      // BBS 409 (version 不一致) 时 BBClientError.message 会带 "expected version X"
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
      try {
        await stateStore.delete(`prs/${pr.localId}/comments`);
      } catch {
        /* cache miss 也无所谓 */
      }
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('comments:changed', { localId: pr.localId });
      }
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
        const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
        if (!adapter) return null;
        // 传 pr.repo 给 adapter — BBS 的 attachment: 协议需要 repo 上下文拼 URL
        const res = await adapter.getAttachment(req.url, pr.repo);
        if (!res) return null;
        const base64 = Buffer.from(res.bytes).toString('base64');
        return { dataUrl: `data:${res.contentType};base64,${base64}` };
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    'app:userAvatar',
    async (
      _evt,
      req: IpcChannels['app:userAvatar']['request'],
    ): Promise<IpcChannels['app:userAvatar']['response']> => {
      const memKey = `${req.connectionId}|${req.slug}`;
      if (avatarMem.has(memKey)) return avatarMem.get(memKey)!;

      const hash = crypto
        .createHash('sha256')
        .update(memKey)
        .digest('hex')
        .slice(0, 24);
      const filePath = path.join(avatarDir, `${hash}.bin`);

      // 1) 磁盘 cache 命中且未过期？命中不打日志 (高频路径，避免日志噪音)
      try {
        const stat = await fs.stat(filePath);
        const age = Date.now() - stat.mtimeMs;
        if (age < AVATAR_TTL_MS) {
          const bytes = await fs.readFile(filePath);
          const contentType = sniffImageContentType(bytes);
          const result = {
            dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
          };
          avatarMem.set(memKey, result);
          return result;
        }
        // 过期：删了重拉。删失败也没关系（writeFile 会覆盖）
        await fs.unlink(filePath).catch(() => undefined);
      } catch {
        // 文件不存在 / 读失败 → 走 fetch
      }

      // 2) 没缓存 / 已过期：去 BBS 拉
      const adapter = adapters.find((a) => a.connectionId === req.connectionId)?.adapter;
      if (!adapter) {
        avatarMem.set(memKey, null);
        return null;
      }
      try {
        const img = await adapter.getUserAvatar(req.slug);
        if (!img) {
          logger.debug(
            { connectionId: req.connectionId, slug: req.slug },
            'avatar fetch returned null',
          );
          avatarMem.set(memKey, null);
          return null;
        }
        // 落盘：best-effort，写失败不影响响应
        try {
          await fs.mkdir(avatarDir, { recursive: true });
          await fs.writeFile(filePath, img.bytes);
        } catch (writeErr) {
          logger.warn({ err: writeErr, hash }, 'avatar disk write failed');
        }
        const base64 = Buffer.from(img.bytes).toString('base64');
        const result = { dataUrl: `data:${img.contentType};base64,${base64}` };
        avatarMem.set(memKey, result);
        logger.debug(
          {
            hash,
            slug: req.slug,
            bytes: img.bytes.length,
            contentType: img.contentType,
          },
          'avatar fetched + cached to disk',
        );
        return result;
      } catch (err) {
        logger.warn(
          { err, connectionId: req.connectionId, slug: req.slug },
          'avatar fetch threw',
        );
        avatarMem.set(memKey, null);
        return null;
      }
    },
  );
  ipcMain.handle('config:read', (): IpcChannels['config:read']['response'] => bootstrap.config);
  ipcMain.handle('app:openConfigFile', async (): Promise<void> => {
    const err = await shell.openPath(bootstrap.paths.configFile);
    if (err) throw new Error(`failed to open config.yaml: ${err}`);
  });
  ipcMain.handle('app:openDevTools', (evt) => {
    evt.sender.openDevTools({ mode: 'detach' });
  });
  ipcMain.handle(
    'app:openExternal',
    async (_evt, req: IpcChannels['app:openExternal']['request']): Promise<void> => {
      // 白名单：仅放行 http(s)，防止 file:// / javascript: 等被恶意 markdown 注入触发
      if (!/^https?:\/\//.test(req.url)) return;
      await shell.openExternal(req.url);
    },
  );

  ipcMain.handle(
    'dialog:pickDirectory',
    async (
      evt,
      req: IpcChannels['dialog:pickDirectory']['request'],
    ): Promise<IpcChannels['dialog:pickDirectory']['response']> => {
      const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: req.title ?? '选择目录',
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

  ipcMain.handle(
    'prs:list',
    async (): Promise<IpcChannels['prs:list']['response']> => listStoredPullRequests(stateStore),
  );
  ipcMain.handle(
    'prs:refresh',
    async (): Promise<IpcChannels['prs:refresh']['response']> => poller.tick(),
  );
  ipcMain.handle(
    'prs:lastSync',
    (): IpcChannels['prs:lastSync']['response'] => ({ at: poller.getLastPollAt() }),
  );
  ipcMain.handle(
    'prs:setLocalStatus',
    async (
      _evt,
      req: IpcChannels['prs:setLocalStatus']['request'],
    ): Promise<IpcChannels['prs:setLocalStatus']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      // 先写远端：本地 status → BBS reviewer.status；失败抛出，前端不会看到本地变更
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
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      // 合并远端；失败 (冲突 / veto / 权限) 抛出，renderer 提示，本地不变。
      // 成功后不在此落本地：PR 转 MERGED 会从 pending 消失，靠 renderer 触发的
      // refresh → poll 软删收尾，避免本地状态与远端各执一词
      await adapter.mergePullRequest(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
      );
    },
  );

  /**
   * 打开 PR 时镜像就位的保障。优先快速路径：本地 bare 已含 head+base 两个 sha
   * → 直接回 mirrorPath，不打远端。两 sha 都齐意味着上次 sync 已经覆盖了本 PR
   * 的 commit 范围（PR sha 是 immutable 的），renderer 可以直接走本地 diff 计算。
   *
   * 缺 sha (任一) → 走 syncMirror 兜底走 git fetch。
   *
   * 后台 poll 在拿到 PR 状态更新后会主动 syncMirror，所以正常打开 PR 时
   * 快速路径命中率应该很高。
   */
  const ensureMirrorReadyForPr = async (
    pr: StoredPullRequest,
  ): Promise<{ mirrorPath: string; freshClone: boolean }> => {
    const id = repoIdentityFor(pr);
    const [hasHead, hasBase] = await Promise.all([
      repoMirror.hasCommit(id, pr.sourceRef.sha),
      repoMirror.hasCommit(id, pr.targetRef.sha),
    ]);
    if (hasHead && hasBase) {
      // 快速路径：mirror 已含 head + base，直接回不打远端。命中频繁，不打 log
      return { mirrorPath: repoMirror.mirrorPath(id), freshClone: false };
    }
    const r = await repoMirror.syncMirror(id);
    return { mirrorPath: r.mirrorPath, freshClone: r.freshClone };
  };

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
      return repoMirror.listChangedFiles(id, pr.targetRef.sha, pr.sourceRef.sha);
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
      const sha = req.side === 'base' ? pr.targetRef.sha : pr.sourceRef.sha;
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
  // 并行调 listComments(force:true)，没去重的话会打 3 次 BBS API。同一 localId
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
      // 不打远端。PR 任何变更 (新评论 / 状态等) BBS 都会更新 updatedAt，跳变即重拉。
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
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
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
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
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
      // 本地 git 算 base..head；不打远端、不主动触发 sync。镜像还没拉齐就返回 null，
      // UI 角标暂不显示，等下次 poll 触发 syncMirror 完成后自然命中
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
      const [allBlame, changedSet] = await Promise.all([
        repoMirror.getBlame(id, pr.sourceRef.sha, req.path),
        repoMirror.listChangedHeadLines(id, pr.targetRef.sha, pr.sourceRef.sha, req.path),
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

  /**
   * 真正执行一个 queue item：startReviewRun → worktree → bridge.run → finishWith。
   * 由 runNext() 调用，签名稳定后跟 queue 主体解耦；任何抛错都被 runNext 兜成
   * Promise reject，外层 pragent:run 调用方收到。
   */
  const executeRun = async (item: QueueItem): Promise<ReviewRun> => {
    if (!prAgentBridge) throw new Error('pr-agent 未就绪');
    const { req, pr } = item;
    // 提前 resolve active LLM profile — model 字段要随 startReviewRun 一起落
    // 盘，让 UI 在 meta 行展示"这次 run 用的什么模型"。后面 buildPragentEnv
    // 同样会用到，这里 resolve 一次复用
    const activeLlmForRecord = resolveActiveLlmProfile(bootstrap.config.llm);
    // 用入队预分配的 runId 覆盖 startReviewRun 的自生 id，让 cancel(runId) 在 active
    // 状态也能精确定位 (跟入队时给的 runId 一致)
    const run = await startReviewRun(stateStore, {
      id: item.info.runId,
      prLocalId: pr.localId,
      tool: req.tool,
      question: req.tool === 'ask' ? req.question : undefined,
      prAgentVersion: prAgentBridge.version,
      strategy: prAgentBridge.strategy,
      // 持久化用 profile.model 原文，不做 normalizeModel 前缀处理 — 跟用户
      // Settings 里看到的名字一致更直观
      model: activeLlmForRecord?.model || undefined,
    });
    // 把入队时 startedAt=null 的 info 升级为 active 形态 + 广播
    item.info = { ...item.info, startedAt: run.startedAt };
    broadcastQueueChanged();
    logger.info(
      { runId: run.id, localId: pr.localId, tool: req.tool, strategy: prAgentBridge.strategy },
      'pragent run start',
    );
    const t0 = Date.now();
    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('pragent:runProgress', { runId: run.id, line, stream });
      }
    };

    const finishWith = async (
      patch: Parameters<typeof finishReviewRun>[3],
    ): Promise<ReviewRun> => {
      const updated = await finishReviewRun(stateStore, pr.localId, run.id, patch);
      return updated ?? { ...run, ...patch };
    };

    const repoId = repoIdentityFor(pr);
    await repoMirror.syncMirror(repoId);
    const wt = await repoMirror.materializeWorktree(
      repoId,
      pr.sourceRef.sha,
      pr.targetRef.sha,
    );
    const ac = item.ac!;
    try {
        const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
        // LLM env + 全局 pr-agent 配置 (响应语言)。语言配置一期写死在 config 里，
        // UI 还不暴露切换；后续多语言时改成 Settings 入口
        const env: Record<string, string> = {
          ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
          CONFIG__RESPONSE_LANGUAGE: bootstrap.config.language,
        };

        // 注给 pr-agent 的 EXTRA_INSTRUCTIONS 由三部分按顺序拼接：
        //   1. 语言指示：CONFIG__RESPONSE_LANGUAGE 对 /describe /review 够用，但
        //      /ask 走 [pr_questions] 配置段不那么严格遵守，必须显式 prompt 强化
        //   2. PR 上下文 (title / description / 已有评论)：local provider 自己不会
        //      去 BBS 拉这些，必须我们这边喂；让 /describe /review 不只是看 diff
        //   3. 规则正文 (rules.dir 命中)：项目编码规约
        // /ask 只取 1 (语言)，跳 2/3 (用户问题往往跟历史评论 / 规约无关)
        const langDirective = languageDirectiveFor(bootstrap.config.language);
        let prContext = '';
        let matchedRuleInstructions = '';
        let matchedRuleId: string | undefined;
        if (req.tool !== 'ask') {
          const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
          if (adapter) {
            try {
              prContext = await buildPrContext({ pr, adapter, logger });
            } catch (err) {
              logger.warn(
                { err, runId: run.id, localId: pr.localId },
                'buildPrContext threw; proceeding without PR context',
              );
            }
          }

          const rulesCfg = bootstrap.config.rules;
          if (rulesCfg.enabled && rulesCfg.dir) {
            const rules = await loadRules(rulesCfg.dir, {
              onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
            });
            const matched = pickMatchingRule(rules, {
              projectKey: pr.repo.projectKey,
              repoSlug: pr.repo.repoSlug,
              targetBranch: pr.targetRef.displayId,
              tool: req.tool,
            });
            if (matched) {
              matchedRuleInstructions = matched.instructions;
              matchedRuleId = matched.id;
            }
          }
        }

        // anchor marker 指令：让 model 在涉及代码位置的内容末尾显式追加
        //   [file: <path>, lines: <start_line>-<end_line>]
        // parse-output.ts 的 inferAnchorFromIssueText 优先认这个 marker 抽 anchor，
        // UI 据此渲染"→ 编辑"按钮一键跳转 DiffView 行内评论草稿。
        //
        // pr-agent LocalGitProvider 渲染 key_issues_to_review 时
        // (get_line_link='' + gfm_supported=False) 会把 relevant_file / start_line /
        // end_line 字段全部丢掉，渲染后的 review.md 只剩 **header** + content 两行
        // (见 ADR-0007 §诊断)，所以 /review 必须靠这条 marker 才能拿到 anchor。
        //
        // 两种工具措辞不同：
        // - /review: 每条 key_issue 末尾 **必加** marker
        // - /ask: 仅当回答涉及具体文件 / 代码位置时 **才加** (自由问答可能完全跟代码
        //   无关 e.g. "PR 概述")，强制会产出假阳性
        //
        // /describe / /improve 不注入：前者不出 issue，后者走 marker 行
        // `[file [start-end]](url)` 自己有 anchor
        const reviewAnchorDirective =
          req.tool === 'review'
            ? [
                'When writing each item under `key_issues_to_review`, append on its OWN LAST LINE',
                'a machine-readable anchor marker in this EXACT format:',
                '',
                '    [file: <relevant_file>, lines: <start_line>-<end_line>]',
                '',
                'Examples:',
                '  [file: src/auth/login.ts, lines: 42-50]',
                '  [file: pkg/cache.go, lines: 17]',
                '',
                'Use the exact relevant_file path and start_line/end_line you already',
                'identified in the YAML output. Do NOT wrap the path in backticks. If you',
                'truly cannot identify a file/line for an issue, omit the marker for that',
                'item only.',
              ].join('\n')
            : req.tool === 'ask'
              ? [
                  'CRITICAL: This answer is consumed by a code review GUI that converts your',
                  'per-paragraph recommendations into INLINE COMMENTS pinned to specific code',
                  'lines. For that to work, EVERY paragraph that names a code symbol (function,',
                  'method, class, variable, identifier) from this PR MUST end with a',
                  'machine-readable anchor marker on its OWN LAST LINE:',
                  '',
                  '    [file: <path>, lines: <start_line>-<end_line>]',
                  '',
                  'Examples:',
                  '  [file: src/auth/login.ts, lines: 42-50]',
                  '  [file: pkg/cache.go, lines: 17]',
                  '  [file: pkg/store.ts]              (path-only fallback; only when you',
                  '                                     truly cannot infer any line number)',
                  '',
                  'How to derive line numbers from the diff:',
                  '- Every hunk in the diff begins with a header:',
                  '    @@ -<base_start>,<base_count> +<head_start>,<head_count> @@',
                  '  The number after `+` is the FIRST head-side line of that hunk. Count down',
                  '  through `+` (added) and ` ` (context) lines — DO NOT count `-` (removed)',
                  '  lines — to locate the line where the symbol appears. Prefer head-side',
                  '  line numbers. For code that ONLY exists on the base side (purely removed),',
                  '  use the base-side `-` line number instead.',
                  '',
                  'Rules — read carefully:',
                  '- The marker is REQUIRED. Do not skip it when your paragraph references a',
                  '  real code symbol from the diff. A paragraph without a marker becomes',
                  '  un-pinnable feedback the user cannot turn into a comment.',
                  '- Append exactly ONE marker per paragraph, at the very end of that paragraph,',
                  '  on its own line (blank line above it optional but recommended).',
                  '- If a paragraph discusses multiple locations, pick the most important one',
                  '  (the line where the recommended change should be made).',
                  '- Paragraphs that are purely general / conceptual / meta (e.g., overall',
                  '  praise, no specific symbol named) MAY omit the marker.',
                  '- Use the exact file path from the diff. Do NOT wrap the path in backticks',
                  '  or quotes inside the marker.',
                  '- If you really cannot pin a line, fall back to path-only `[file: <path>]`',
                  '  rather than omitting the marker entirely.',
                ].join('\n')
              : '';

        const extraParts = [
          langDirective,
          reviewAnchorDirective,
          prContext,
          matchedRuleInstructions,
        ].filter((s) => s.trim());
        if (extraParts.length > 0) {
          const envKey =
            req.tool === 'describe'
              ? 'PR_DESCRIPTION__EXTRA_INSTRUCTIONS'
              : req.tool === 'review'
                ? 'PR_REVIEWER__EXTRA_INSTRUCTIONS'
                : req.tool === 'improve'
                  ? 'PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS'
                  : 'PR_QUESTIONS__EXTRA_INSTRUCTIONS';
          env[envKey] = extraParts.join('\n\n---\n\n');
        }
        if (matchedRuleId) {
          logger.info(
            { runId: run.id, ruleId: matchedRuleId, tool: req.tool },
            'pragent run: matched rule',
          );
        }
        if (prContext) {
          logger.debug(
            { runId: run.id, tool: req.tool, contextChars: prContext.length },
            'pragent run: pr context injected',
          );
        }


        // ask 工具的问题作为位置参数 (spawn args 单元素，含空格也是一个 arg 不切分)
        const extraArgs = req.tool === 'ask' && req.question ? [req.question] : undefined;

        // embedded 策略：执行期在嵌入式安装目录补空 .secrets.toml 压掉同样的告警
        // （没有容器可挂载，直接写安装目录；memo 化只首次做）
        if (prAgentBridge.strategy === 'embedded' && embeddedPythonPath) {
          await ensureEmbeddedSecrets(embeddedPythonPath);
        }

        // Docker 策略：挂个空 secrets.toml 压掉 pr-agent 的 "settings file not found"
        // 启动告警；LocalCli 不需要 (pipx 装的 pr-agent 路径不同，告警也不出)
        const dockerExtraVolumes =
          prAgentBridge.strategy === 'docker'
            ? await (async () => {
                const empty = await ensureEmptySecretsFile();
                return [
                  { host: empty, container: '/app/pr_agent/settings/.secrets.toml', readonly: true },
                  {
                    host: empty,
                    container: '/app/pr_agent/settings_prod/.secrets.toml',
                    readonly: true,
                  },
                ];
              })()
            : undefined;

        const result = await prAgentBridge.run({
          prUrl: pr.url,
          tool: req.tool,
          env,
          onLine,
          cwd: wt.path,
          targetBranch: wt.targetBranchName,
          extraArgs,
          dockerExtraVolumes,
          signal: ac.signal,
        });
        // pr-agent 的 local provider 把生成结果**写到工作树根的 markdown 文件**：
        //   /describe → <wt>/description.md  (走 publish_description)
        //   /review   → <wt>/review.md       (走 publish_comment)
        //   /ask      → <wt>/review.md       ← 共用同一文件 (publish_comment 会覆盖)
        //   /improve  → <wt>/review.md       ← 同上：local provider 不实现
        //                                      publish_code_suggestions，汇总走 publish_comment
        // 走 worktree 路径，cleanup 前必须先把文件读出来。
        const outFile = req.tool === 'describe' ? 'description.md' : 'review.md';
        let fileContent = '';
        try {
          fileContent = await fs.readFile(path.join(wt.path, outFile), 'utf8');
        } catch (readErr) {
          logger.warn(
            { err: readErr, wtPath: wt.path, outFile, runId: run.id },
            'pr-agent local provider output file missing; fall back to stdout',
          );
        }
        // /ask 输出里 pr-agent 把问题原样回显在 answer body 顶部 (跟 chat 输入气泡完全
         // 重复)。在解析前把跟用户问题逐字匹配的整行删掉，避免渲染时出现两次问题
        const cleanedContent =
          req.tool === 'ask' && req.question?.trim()
            ? stripAskQuestionEcho(fileContent, req.question)
            : fileContent;
        const parsed = parseReviewOutput(cleanedContent || result.stdout, req.tool);
        // M4 草稿再摄入 (ADR-0007 §2)：/review 成功完成时丢掉 pending+finding 旧草稿，
        // 让本轮 ChatPane 上的 finding 列表成为新的候选源。edited/posted/rejected/
        // manual 保留不动。失败的 /review 不触发清理 (没建设性数据)。
        if (req.tool === 'review') {
          try {
            const dropped = await dropPendingFindingDrafts(stateStore, pr.localId);
            if (dropped > 0) {
              logger.info(
                { runId: run.id, localId: pr.localId, dropped },
                'pragent /review: dropped stale pending drafts',
              );
              broadcastDraftsChanged(pr.localId);
            }
          } catch (err) {
            logger.warn({ err, runId: run.id }, 'dropPendingFindingDrafts failed');
          }
        }
        // pr-agent CLI 可能 exit 0 但 stdout 里其实是 LLM 调用全失败 (litellm
        // AuthenticationError / "Failed to generate prediction with any model" 等
        // marker)。parseReviewOutput 会在 ParsedReviewOutput.llmFailure 标出 —
        // 此时不算 succeeded，落盘为 failed + reason='llm-error'，UI 用红色失败
        // chip 渲染而不是"完成"
        if (parsed.llmFailure) {
          logger.warn(
            { runId: run.id, reason: parsed.llmFailure.message },
            'pragent exit 0 but LLM call failed; marking run as failed',
          );
          return await finishWith({
            status: 'failed',
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - t0,
            exitCode: result.exitCode,
            errorReason: 'llm-error',
            errorMessage: parsed.llmFailure.message,
            stdout: fileContent
              ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
              : result.stdout,
            stderr: result.stderr,
            findings: parsed.findings,
            summary: parsed.summary,
          });
        }
        return await finishWith({
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: result.exitCode,
          // 持久化「LLM 真实产出」(文件内容)；stdout 留作日志在折叠区供排障
          stdout: fileContent
            ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
            : result.stdout,
          stderr: result.stderr,
          findings: parsed.findings,
          summary: parsed.summary,
        });
      } catch (err) {
        if (err instanceof PrAgentRunError) {
          // 用户主动取消 → status='cancelled'，其它 reason → 'failed'。
          // 二者都仍走 finishReviewRun 落盘，让 UI 能从历史 run 里看到这次取消事件
          const status: ReviewRunStatus = err.reason === 'cancelled' ? 'cancelled' : 'failed';
          logger.warn(
            { runId: run.id, reason: err.reason, exitCode: err.result.exitCode },
            `pragent run ${status}`,
          );
          // 失败 / 取消时也尽量解析已收集的 stdout：很多情况 pr-agent 已写了一部分输出
          const partialStdout = err.result.stdout ?? '';
          const parsed = partialStdout
            ? parseReviewOutput(partialStdout, req.tool)
            : { findings: [], summary: undefined };
          return await finishWith({
            status,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - t0,
            exitCode: err.result.exitCode,
            errorReason: err.reason,
            errorMessage: err.message,
            stdout: err.result.stdout,
            stderr: err.result.stderr,
            findings: parsed.findings,
            summary: parsed.summary,
          });
        }
        // 非预期异常：仍记一笔 failed，避免 run 永远卡在 running，再把异常往上抛
        await finishWith({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      throw err;
    } finally {
      await wt.cleanup();
    }
  };

  /** 队列消费循环：active 空时从 waiting 取一条来跑；自身不并发 (active 占位) */
  const runNext = (): void => {
    if (active) return;
    const item = waiting.shift();
    if (!item) {
      broadcastQueueChanged();
      return;
    }
    active = item;
    item.ac = new AbortController();
    void executeRun(item)
      .then((finished) => item.resolve(finished))
      .catch((err: unknown) => {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        active = null;
        broadcastQueueChanged();
        // 链式开下一条；放微任务里避免栈累积
        queueMicrotask(runNext);
      });
  };

  ipcMain.handle(
    'pragent:run',
    async (
      _evt,
      req: IpcChannels['pragent:run']['request'],
    ): Promise<IpcChannels['pragent:run']['response']> => {
      if (!prAgentBridge) {
        throw new Error(
          'pr-agent 未就绪：本机 CLI 与 Docker 都未探测到。Settings 页查看探测细节',
        );
      }
      // 早期校验：/ask 必须带 question，避免排队后才报错
      if (req.tool === 'ask' && !req.question?.trim()) {
        throw new Error('/ask 需要提供 question');
      }
      const pr = await findPrOrThrow(req.localId);
      // 入队时就分配 runId；后续 cancel(runId) 在 waiting / active 都能定位
      const runId = makeRunId(new Date());
      return new Promise<ReviewRun>((resolve, reject) => {
        const item: QueueItem = {
          info: {
            runId,
            prLocalId: pr.localId,
            tool: req.tool,
            question: req.tool === 'ask' ? req.question : undefined,
            enqueuedAt: new Date().toISOString(),
            startedAt: null,
          },
          req,
          pr,
          resolve,
          reject,
        };
        waiting.push(item);
        logger.info(
          { runId, localId: pr.localId, tool: req.tool, queueLen: waiting.length },
          'pragent run enqueued',
        );
        broadcastQueueChanged();
        runNext();
      });
    },
  );

  ipcMain.handle(
    'pragent:cancel',
    async (
      _evt,
      req: IpcChannels['pragent:cancel']['request'],
    ): Promise<IpcChannels['pragent:cancel']['response']> => {
      // active 命中 → SIGKILL (finally 会写 cancelled 到 disk)
      if (active?.info.runId === req.runId) {
        logger.info({ runId: req.runId }, 'pragent run cancel: active');
        active.ac?.abort();
        return { ok: true };
      }
      // waiting 命中 → 从队列删除 + reject 原 Promise，不写盘 (从未真正跑过)
      const idx = waiting.findIndex((q) => q.info.runId === req.runId);
      if (idx >= 0) {
        const [removed] = waiting.splice(idx, 1);
        logger.info(
          { runId: req.runId, queueLen: waiting.length },
          'pragent run cancel: queued',
        );
        removed!.reject(new Error('queued run cancelled'));
        broadcastQueueChanged();
        return { ok: true };
      }
      return { ok: false };
    },
  );

  ipcMain.handle(
    'pragent:queue',
    (): IpcChannels['pragent:queue']['response'] => ({
      active: active?.info ?? null,
      waiting: waiting.map((q) => q.info),
    }),
  );

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

  // === M4 草稿 IPC ===
  // 所有 mutator (create / update / delete) 写盘成功后立刻广播 drafts:changed，
  // renderer drafts-store 据此重拉刷新

  ipcMain.handle(
    'drafts:list',
    async (
      _evt,
      req: IpcChannels['drafts:list']['request'],
    ): Promise<IpcChannels['drafts:list']['response']> =>
      listDrafts(stateStore, req.localId),
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
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);

      // 拉一次当前草稿池：localId → id → draft，下面遍历 draftIds 时按 id 查。
      // 不在循环里反复 listDrafts，避免 PR 草稿量大时 O(N²) IO
      const allDrafts = await listDrafts(stateStore, req.localId);
      const draftById = new Map(allDrafts.map((d) => [d.id, d]));

      const results: IpcChannels['drafts:publishBatch']['response']['results'] = [];
      let anyPublished = false;
      for (const draftId of req.draftIds) {
        const draft = draftById.get(draftId);
        if (!draft) {
          results.push({ draftId, ok: false, error: '草稿不存在 (可能已被删除)' });
          continue;
        }
        // 状态守卫：rejected 不发 (用户决断不发)。
        // posted 不再守卫 — 发布成功后本地草稿直接删除，不存 'posted' 历史状态，
        // 调用方传过来的 draftId 在 listDrafts 找不到时已经被前面 `if (!draft)` 兜住
        if (draft.status === 'rejected') {
          results.push({ draftId, ok: false, error: '草稿已被拒绝，跳过' });
          continue;
        }
        try {
          // ReviewDraftAnchor → PrCommentAnchor 转换：
          // - draft.anchor 没有 lineType (草稿创建时不知道这一行的 diff 角色)，
          //   按 side 做保守映射：new→added / old→removed。pr-pilot 的草稿大多锚到
          //   变更行 (finding 来自 /review 的 issue + DraftZone hover '+' 也只对
          //   变更行可见)，context 行评论场景极少。命中 context 时 BBS 回 400，
          //   错误会被 catch 收到 results 里给用户看
          // - 多行 (endLine > startLine) 在 BBS REST 里无法表达 (anchor.line 是单
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
          // 发布成功 = 本地草稿使命完成，直接删掉保持草稿池干净。远端 BBS 评论
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

      // 至少有一条发成功 → force-refresh BBS 评论：清缓存 + 广播 comments:changed
      // 让 CommentsPanel / DiffView 内嵌评论立即看到自己刚发的，不用等下一轮 poller
      if (anyPublished) {
        try {
          await stateStore.delete(`prs/${pr.localId}/comments`);
        } catch {
          /* cache miss 无所谓 */
        }
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('comments:changed', { localId: pr.localId });
        }
      }
      return { results };
    },
  );

  ipcMain.handle(
    'config:setReposDir',
    async (_evt, req: IpcChannels['config:setReposDir']['request']): Promise<void> => {
      const next = {
        ...bootstrap.config,
        workspace: {
          ...bootstrap.config.workspace,
          repos_dir: req.reposDir,
        },
      };
      await writeConfig(bootstrap.paths.configFile, next);
      logger.info({ reposDir: req.reposDir }, 'repos_dir updated; restart required');
    },
  );

  ipcMain.handle(
    'config:setRules',
    async (_evt, req: IpcChannels['config:setRules']['request']): Promise<void> => {
      const next = { ...bootstrap.config, rules: req.rules };
      await writeConfig(bootstrap.paths.configFile, next);
      bootstrap.config.rules = req.rules;
      logger.info({ rules: req.rules }, 'rules config updated');
    },
  );

  ipcMain.handle(
    'rules:matchForPr',
    async (
      _evt,
      req: IpcChannels['rules:matchForPr']['request'],
    ): Promise<IpcChannels['rules:matchForPr']['response']> => {
      const cfg = bootstrap.config.rules;
      if (!cfg.enabled || !cfg.dir) return null;
      // ask 工具不接规则 (问答自由形式，没什么"规约"可应用)
      if (req.tool === 'ask') return null;
      const pr = await findPrOrThrow(req.localId);
      const rules = await loadRules(cfg.dir, {
        onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
      });
      const matched = pickMatchingRule(rules, {
        projectKey: pr.repo.projectKey,
        repoSlug: pr.repo.repoSlug,
        targetBranch: pr.targetRef.displayId,
        tool: req.tool,
      });
      if (!matched) return null;
      return {
        id: matched.id,
        filePath: matched.filePath,
        priority: matched.priority,
        tools: [...matched.tools],
        instructions: matched.instructions,
      };
    },
  );

  ipcMain.handle(
    'config:setLlm',
    async (_evt, req: IpcChannels['config:setLlm']['request']): Promise<void> => {
      const next = { ...bootstrap.config, llm: req.llm };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存中 config 同步更新，下一次 pragent:run 立刻用新值（不等重启）
      bootstrap.config.llm = req.llm;
      logger.info(
        {
          profileCount: req.llm.profiles.length,
          activeId: req.llm.active_id,
        },
        'llm config updated',
      );
    },
  );

  logger.debug('IPC handlers registered');
}

/**
 * 把 config.language (ISO locale) 翻成自然语言 prompt directive，注入到 pr-agent
 * 各 tool 的 EXTRA_INSTRUCTIONS。
 *
 * CONFIG__RESPONSE_LANGUAGE 对 /describe /review 已经够用 (内嵌在它们的 prompt
 * template)，但 /ask 不严格遵守；显式 prompt 强化所有 tool，尤其覆盖 /ask + 表格
 * 类输出的标题 / 列名 / 段落标记。
 *
 * 英文 (en-US) 返回空串，避免给 LLM 加不必要的提示。其他未知 locale 返回空保留
 * pr-agent 原行为。
 */
function languageDirectiveFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return 'Respond in Simplified Chinese (简体中文). All section labels, table headers, column names, headings, and content MUST be in Chinese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return 'Respond in Traditional Chinese (繁體中文). All section labels, table headers, column names, headings, and content MUST be in Chinese.';
  }
  return '';
}

/**
 * 给每条评论 (含 replies 子树) 打 canDelete / canEdit 标志。
 *
 * - canDelete: author.name === 当前 PAT 用户 && 无 reply && 有 version
 *   (BBS 拒删带 reply 的；DELETE 必带 version 乐观锁)
 * - canEdit:   author.name === 当前 PAT 用户 && 有 version
 *   (BBS 允许编辑带 reply 的评论；PUT 也带 version)
 *
 * 当前用户拿不到 (ping 未完成 / 失败) → 全部 false。renderer 直读 flag 不再
 * 自己比对 author / version / replies，链路最短最稳。
 */
function annotateOwnership(
  comments: PrComment[],
  adapter: PlatformAdapter,
): PrComment[] {
  const me = adapter.getCurrentUser();
  if (!me) {
    return setOwnershipRecursive(comments, () => ({ canDelete: false, canEdit: false }));
  }
  return setOwnershipRecursive(comments, (c) => {
    const isMine = c.author.name === me.name;
    const hasVersion = typeof c.version === 'number';
    return {
      canDelete: isMine && c.replies.length === 0 && hasVersion,
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

function buildAppInfo(bootstrap: BootstrapResult): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    firstRun: bootstrap.firstRun,
  };
}

function buildConnectionSummaries(
  bootstrap: BootstrapResult,
  adapters: readonly BuiltAdapter[],
): ConnectionSummary[] {
  return adapters.map(({ connectionId, adapter }) => {
    const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
    return {
      connectionId,
      displayName: conn?.display_name ?? connectionId,
      user: adapter.getCurrentUser(),
    };
  });
}
