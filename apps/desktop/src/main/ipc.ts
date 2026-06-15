import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import {
  buildToolCatalog,
  judgeAutopilotBatch,
  loadAgentContext,
  loadAgentRules,
} from '@meebox/agent';
import type { AgentContext } from '@meebox/agent';
import { writeConfig, type BootstrapResult } from '@meebox/config';
import { PrAgentRunError, type PrAgentBridge } from '@meebox/pr-agent-bridge';
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
  clearReviewRunsForPr,
  listStoredPullRequests,
  makeRunId,
  parseReviewOutput,
  readCommentsCache,
  setLocalStatus,
  startReviewRun,
  updateDraft,
  writeCommentsCache,
  writeAutopilotLedger,
  needsAutoReview,
  getAutopilotLedger,
} from '@meebox/poller';
import type { RepoIdentity, RepoMirrorManager } from '@meebox/repo-mirror';
import { pickMatchingRule } from '@meebox/rules';
import type {
  AgentRecommendationVerdict,
  AgentSession,
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
  TokenUsage,
} from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import { buildDraftAdapter, type BuiltAdapter, type ConnectionRuntime } from './adapters.js';
import { t, getMainLanguage, setMainLanguage } from './i18n/index.js';
import { sniffImageContentType } from './utils/image.js';
import { buildPragentEnv, resolveActiveLlmProfile } from './utils/agent.js';
import { buildProxyEnv, testProxyConnectivity } from './utils/proxy.js';
import { checkForUpdate } from './utils/update-check.js';
import { buildPrContext } from './utils/pr-context.js';
import { runAgentReview } from './agent-review.js';
import { runAgentPlanning } from './agent-planning.js';

interface RegisterDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
  /** 惰性取 pr-agent 探测状态：探测异步进行（不阻塞建窗），await 拿最终结果 */
  getPrAgentStatus: () => Promise<PrAgentStatus>;
  /** 惰性取 bridge 实例；探测未完成 / 不可用 (embedded / CLI 都没有) 时为 null */
  getPrAgentBridge: () => PrAgentBridge | null;
  /** 嵌入式运行时解释器路径（embedded 策略下执行期补 .secrets.toml 用），非 embedded 可空 */
  embeddedPythonPath?: string;
  stateStore: JsonFileStateStore;
  poller: Poller;
  /** 可变连接运行时（全量 adapters + adapterByHost）；设置页改连接后被 reconfigure 原地替换 */
  connectionRuntime: ConnectionRuntime;
  /** 重建 adapters/poller 使连接变更热生效（config:setConnections 写盘后调用） */
  reconfigureConnections: () => Promise<void>;
  repoMirror: RepoMirrorManager;
}

/**
 * 注册全部 IPC handler。后续新增 channel 时只需扩 IpcChannels + 在此添加一个 handle。
 * 故意保持显式，每个 channel 一行映射，方便审计 main↔renderer 暴露面。
 */
export function registerIpcHandlers({
  bootstrap,
  logger,
  getPrAgentStatus,
  getPrAgentBridge,
  embeddedPythonPath,
  stateStore,
  poller,
  connectionRuntime,
  reconfigureConnections,
  repoMirror,
}: RegisterDeps): { abortAllActiveRuns: () => number; runAutopilotIfDue: () => void } {
  // === pr-agent run 队列 ===
  //
  // FIFO 队列，同时只有 1 条在跑 (避免撞 LLM rate limit / 抢 worktree)，
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
    /** 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。见 §7 调度。 */
    priority: 'user' | 'agent';
    /** 仅 active 状态填；用于 cancel SIGKILL */
    ac?: AbortController;
  }
  const waiting: QueueItem[] = [];
  // 并发运行中的 run（runId → item）；上限 maxConcurrency。post-Docker 下每个 run
  // 独立 worktree（路径带 nonce）+ 独立子进程，并发安全；串行不再是正确性要求。
  const active = new Map<string, QueueItem>();
  const maxConcurrency = bootstrap.config.pr_agent.max_concurrency;

  const broadcastQueueChanged = (): void => {
    const payload = {
      active: [...active.values()].map((q) => q.info),
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

  // embedded 策略：执行期在嵌入式安装目录的 settings/ 与 settings_prod/ 补空
  // .secrets.toml（pr-agent 启动会去找该文件，缺失就打 WARNING；我们走 env 传密钥
  // 不用 secrets.toml，写个空文件压掉告警）。
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
            '# meebox 占位空文件：抑制 pr-agent 缺失 .secrets.toml 的启动告警\n',
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
    (): Promise<IpcChannels['app:prAgentStatus']['response']> => getPrAgentStatus(),
  );
  // 渲染层日志回传：落进同一份 meebox.log（scope=renderer），与 main 日志合流便于排查。
  const rendererLogger = logger.child({ scope: 'renderer' });
  ipcMain.handle('log:write', (_evt, req: IpcChannels['log:write']['request']): void => {
    const obj = req.meta ?? {};
    switch (req.level) {
      case 'error':
        rendererLogger.error(obj, req.msg);
        break;
      case 'warn':
        rendererLogger.warn(obj, req.msg);
        break;
      case 'info':
        rendererLogger.info(obj, req.msg);
        break;
      case 'debug':
        rendererLogger.debug(obj, req.msg);
        break;
    }
  });
  ipcMain.handle('app:connections', (): IpcChannels['app:connections']['response'] =>
    buildConnectionSummaries(bootstrap, connectionRuntime.adapters),
  );

  // (connectionId, slug) → dataUrl 或 null。两级 cache：
  //   1) avatarMem: 进程内 Map，本会话内瞬时返回（含 null 负缓存避免重试失败 slug）
  //   2) 磁盘文件 <cacheDir>/avatars/<hash>.bin，TTL 7 天，按 mtime 判定过期
  //      过期或不存在 → 重新打 Bitbucket → 写回磁盘
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
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
        const adapter = connectionRuntime.adapters.find(
          (a) => a.connectionId === pr.connectionId,
        )?.adapter;
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

  ipcMain.handle(
    'app:userAvatar',
    async (
      _evt,
      req: IpcChannels['app:userAvatar']['request'],
    ): Promise<IpcChannels['app:userAvatar']['response']> => {
      const memKey = `${req.connectionId}|${req.slug}`;
      if (avatarMem.has(memKey)) return avatarMem.get(memKey)!;

      const hash = crypto.createHash('sha256').update(memKey).digest('hex').slice(0, 24);
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

      // 2) 没缓存 / 已过期：去 Bitbucket 拉
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === req.connectionId,
      )?.adapter;
      if (!adapter) {
        avatarMem.set(memKey, null);
        return null;
      }
      try {
        const img = await adapter.getUserAvatar(req.slug, req.avatarUrl);
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
        logger.warn({ err, connectionId: req.connectionId, slug: req.slug }, 'avatar fetch threw');
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
  ipcMain.handle('app:checkUpdate', (): Promise<IpcChannels['app:checkUpdate']['response']> => {
    // 与启动检测一致受 check_enabled 控制：关闭时不发起请求，直接返回禁用结果。
    if (!bootstrap.config.update.check_enabled) {
      return Promise.resolve({
        ok: false,
        hasUpdate: false,
        currentVersion: app.getVersion(),
        error: 'update check disabled by config',
      });
    }
    return checkForUpdate(app.getVersion(), bootstrap.config.proxy);
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
            title: req.title ?? t('dialog.selectDirectory'),
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: req.title ?? t('dialog.selectDirectory'),
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );

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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
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
    const prAgentBridge = getPrAgentBridge();
    if (!prAgentBridge) throw new Error(t('prAgent.notReady'));
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
    // 真实 token 用量累加器：sitecustomize 的 litellm callback 把每次调用的 usage 以
    // `@@MEEBOX_USAGE@@ {json}` 哨兵行打到 stderr，下面 onLine 拦截累加（无需临时文件 / env）。
    const usageAcc = { prompt: 0, completion: 0, total: 0, calls: 0, any: false };
    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      // 拦截 usage 哨兵行：累加后不转发给 renderer（避免污染实时日志）。
      if (stream === 'stderr' && accumulateUsageSentinel(line, usageAcc)) return;
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('pragent:runProgress', { runId: run.id, line, stream });
      }
    };

    const finishWith = async (patch: Parameters<typeof finishReviewRun>[3]): Promise<ReviewRun> => {
      const updated = await finishReviewRun(stateStore, pr.localId, run.id, patch);
      return updated ?? { ...run, ...patch };
    };

    const repoId = repoIdentityFor(pr);
    await repoMirror.syncMirror(repoId);
    const wt = await repoMirror.materializeWorktree(repoId, pr.sourceRef.sha, pr.targetRef.sha);
    const ac = item.ac!;
    try {
      const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
      // LLM env + 全局 pr-agent 配置 (响应语言)。语言配置一期写死在 config 里，
      // UI 还不暴露切换；后续多语言时改成 Settings 入口
      const env: Record<string, string> = {
        // 代理 env 先铺底，LLM/语言配置在后（互不冲突，仅 HTTP(S)_PROXY 类）。
        // 开关开时让嵌入式 python(litellm/httpx) 经代理出网调 LLM。
        ...buildProxyEnv(bootstrap.config.proxy),
        ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
        CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
      };
      if (req.tool === 'improve') {
        // /improve 在 local provider 下只有「汇总建议 → publish_comment」一条可用路径
        // （shim 已强制 gfm_markdown=True）。committable/inline 模式会走
        // publish_code_suggestions → local provider 直接 NotImplementedError，显式关死兜底
        // （pr-agent 默认即 false，此处防上游翻默认值）。
        env['PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS'] = 'false';
        // persistent_comment（默认 true）会走 publish_persistent_comment_with_history →
        // get_issue_comments() 翻历史评论做增量更新 → local provider 不实现，每次 improve
        // 都刷一段 NotImplementedError traceback（被上游捕获后兜底 publish_comment，正文
        // 不丢但日志吵）。local 每次都是全新 worktree、无历史可翻，直接关掉走 publish_comment。
        env['PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT'] = 'false';
        // 输出与 /review /ask 的 review.md 分流：pr-agent 原生支持 local.review_path 覆盖
        // publish_comment 的落盘路径；相对路径按子进程 cwd（= worktree 根）解析。
        env['LOCAL__REVIEW_PATH'] = 'improve.md';
      }

      // 注给 pr-agent 的 EXTRA_INSTRUCTIONS 由三部分按顺序拼接：
      //   1. 语言指示：CONFIG__RESPONSE_LANGUAGE 对 /describe /review 够用，但
      //      /ask 走 [pr_questions] 配置段不那么严格遵守，必须显式 prompt 强化
      //   2. PR 上下文 (title / description / 已有评论)：local provider 自己不会
      //      去 Bitbucket 拉这些，必须我们这边喂；让 /describe /review 不只是看 diff
      //   3. 规则正文 (rules.dir 命中)：项目编码规约
      // /ask 只取 1 (语言)，跳 2/3 (用户问题往往跟历史评论 / 规约无关)
      const langDirective = languageDirectiveFor(getMainLanguage());
      let prContext = '';
      let matchedRuleInstructions = '';
      let matchedRuleId: string | undefined;
      if (req.tool !== 'ask') {
        const adapter = connectionRuntime.adapters.find(
          (a) => a.connectionId === pr.connectionId,
        )?.adapter;
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

        const agentCfg = bootstrap.config.agent;
        if (agentCfg.enabled && agentCfg.dir) {
          const rules = await loadAgentRules(agentCfg.dir, {
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
      //
      // 主路径已改为 sitecustomize 注入 LocalGitProvider.get_line_link → key_issues 渲染成
      // `[**header**](meebox:///<file>#L<s>-L<e>)`，parse-output 取结构化 anchor（path 来自
      // provider 同源、最可靠）。但 #L 行号仍依赖 model 填了 pr-agent 原生 start_line/
      // end_line YAML 字段；实测部分模型只填这条 marker、留空结构化字段 → 链接只有 path。
      // 故这条 marker 作为**行号兜底**保留：parse-output 合并时链接给 path、缺行号则用 marker
      // 的行号补（resolveIssueAnchor）。两路信号都用上，最大化 anchor 覆盖。
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

      // 排版指令：只改 /review 每条 key_issue 的断行排版，提升 GUI 可读性，不增加篇幅。
      // pr-agent 原 prompt 要 "short and concise summary"，模型默认堆成单段长跑文；
      // 渲染层 (ReactMarkdown + remarkBreaks) 忠实呈现，空行分段即成独立 <p>。
      // 关键是「保持简洁」——只在现象/影响/建议的语义边界换行，不得借分段扩写内容。
      // 须与上面的 anchor marker 指令协同：分段在正文内部，marker 仍独占最末行。
      const reviewLayoutDirective =
        req.tool === 'review'
          ? [
              'FORMATTING ONLY: Keep each `key_issues_to_review` item as concise as you',
              'already would — do NOT add length, padding, or extra explanation. The only',
              'change is line breaks: instead of one dense run-on paragraph, insert a BLANK',
              'LINE at the natural boundaries (e.g. problem → impact → suggested fix) so the',
              'text reads as a few short paragraphs. Same words, better layout.',
              '',
              'This applies to the issue PROSE only. The machine-readable anchor marker',
              'described above still goes on its OWN LAST LINE, after the final paragraph',
              '(a blank line may precede it).',
            ].join('\n')
          : '';

      const extraParts = [
        langDirective,
        reviewAnchorDirective,
        reviewLayoutDirective,
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

      // embedded 策略：执行期在嵌入式安装目录补空 .secrets.toml 压掉启动告警
      // （直接写安装目录；memo 化只首次做）。local-cli 不需要 (pipx 装的 pr-agent
      // 路径不同，告警也不出)
      if (prAgentBridge.strategy === 'embedded' && embeddedPythonPath) {
        await ensureEmbeddedSecrets(embeddedPythonPath);
      }

      const result = await prAgentBridge.run({
        prUrl: pr.url,
        tool: req.tool,
        env,
        onLine,
        cwd: wt.path,
        targetBranch: wt.targetBranchName,
        extraArgs,
        signal: ac.signal,
      });
      // 真实 token 用量（onLine 累加的 stderr 哨兵行），落到 succeeded / llm-failed 收尾。
      const tokenUsage = finalizeUsage(usageAcc);
      // pr-agent 的 local provider 把生成结果**写到工作树根的 markdown 文件**：
      //   /describe → <wt>/description.md  (走 publish_description)
      //   /review   → <wt>/review.md       (走 publish_comment)
      //   /ask      → <wt>/review.md       ← 共用同一文件 (publish_comment 会覆盖)
      //   /improve  → <wt>/improve.md      ← 汇总建议走 publish_comment，经 LOCAL__REVIEW_PATH
      //                                      重定向与 review.md 分流（见上方 env 注入）
      // 走 worktree 路径，cleanup 前必须先把文件读出来。
      const outFile =
        req.tool === 'describe'
          ? 'description.md'
          : req.tool === 'improve'
            ? 'improve.md'
            : 'review.md';
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
      // M4 草稿再摄入：/review 成功完成时丢掉 pending+finding 旧草稿，
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
          stderr: stripUsageSentinels(result.stderr),
          findings: parsed.findings,
          summary: parsed.summary,
          tokenUsage,
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
        stderr: stripUsageSentinels(result.stderr),
        findings: parsed.findings,
        summary: parsed.summary,
        tokenUsage,
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
        // 失败 / 取消前可能已有若干次 LLM 调用，尽量把已产生的 token 用量也记上
        const tokenUsage = finalizeUsage(usageAcc);
        return await finishWith({
          status,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: err.result.exitCode,
          errorReason: err.reason,
          errorMessage: err.message,
          stdout: err.result.stdout,
          stderr: stripUsageSentinels(err.result.stderr),
          findings: parsed.findings,
          summary: parsed.summary,
          tokenUsage,
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

  /**
   * 队列泵：在并发未达上限且 waiting 非空时，连续 dequeue 起跑，直到填满 maxConcurrency。
   * 每条 run 结束（成功/失败/取消）后从 active 移除并再泵一次，自然续上后续任务。
   */
  const pump = (): void => {
    while (active.size < maxConcurrency && waiting.length > 0) {
      const item = waiting.shift()!;
      active.set(item.info.runId, item);
      item.ac = new AbortController();
      void executeRun(item)
        .then((finished) => item.resolve(finished))
        .catch((err: unknown) => {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          active.delete(item.info.runId);
          broadcastQueueChanged();
          // 放微任务里再泵，避免递归栈累积
          queueMicrotask(pump);
        });
    }
    broadcastQueueChanged();
  };

  /**
   * 入队一个 pr-agent run（与用户手动 run 共用同一队列 / 并发 / 取消机制）。dedup：同 PR
   * 同工具已在执行 / 排队则抛错（/ask 不限）。resolve 完成的 ReviewRun。
   * `pragent:run` handler 与 Agent 编排器（runTool）都走它。
   */
  const enqueuePragentRun = (
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority: 'user' | 'agent' = 'user',
  ): Promise<ReviewRun> => {
    if (tool !== 'ask') {
      const sameTask = (q: QueueItem): boolean =>
        q.info.prLocalId === pr.localId && q.info.tool === tool;
      if ([...active.values()].some(sameTask) || waiting.some(sameTask)) {
        throw new Error(t('prAgent.duplicateTask', { tool }));
      }
    }
    // 入队时就分配 runId；后续 cancel(runId) 在 waiting / active 都能定位
    const runId = makeRunId(new Date());
    return new Promise<ReviewRun>((resolve, reject) => {
      const item: QueueItem = {
        info: {
          runId,
          prLocalId: pr.localId,
          tool,
          question: tool === 'ask' ? question : undefined,
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
        },
        req: { localId: pr.localId, tool, question },
        pr,
        priority,
        resolve,
        reject,
      };
      // 优先级插队：user 任务排到所有 agent 任务之前（同泳道内仍 FIFO）；不打断在跑的 run。
      if (priority === 'user') {
        const firstAgentIdx = waiting.findIndex((q) => q.priority === 'agent');
        if (firstAgentIdx >= 0) waiting.splice(firstAgentIdx, 0, item);
        else waiting.push(item);
      } else {
        waiting.push(item);
      }
      logger.info(
        { runId, localId: pr.localId, tool, priority, queueLen: waiting.length },
        'pragent run enqueued',
      );
      pump();
    });
  };

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
      return enqueuePragentRun(pr, req.tool, req.question);
    },
  );

  // ── Agent 评审编排：共享 chat 通道 + 单 PR 微流程，agent:run 与 AutoPilot 都用 ──
  type AgentChat = (input: {
    system: string;
    user: string;
  }) => Promise<{ text: string; usage?: TokenUsage }>;

  /** 设置 LLM env + 临时 chat cwd + chat 函数，运行 fn，收尾清理临时目录。 */
  const withAgentChat = async <T>(fn: (chat: AgentChat) => Promise<T>): Promise<T> => {
    const bridge = getPrAgentBridge();
    if (!bridge) throw new Error(t('prAgent.notReadyDetail'));
    // 复用与 pr-agent run 同一套 LLM env（provider 凭据 / 模型 / 代理 / 响应语言）。
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
      CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
    };
    // chat 子进程落到中性临时目录（cli 模式避免吃到被评审仓库的 CLAUDE.md）。
    const chatCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-agent-chat-'));
    try {
      const chat: AgentChat = async ({ system, user }) => {
        const r = await bridge.chat({ system, user, env, cwd: chatCwd });
        const acc: UsageAcc = { prompt: 0, completion: 0, total: 0, calls: 0, any: false };
        for (const line of (r.stderr ?? '').split('\n')) accumulateUsageSentinel(line, acc);
        return { text: r.stdout.trim(), usage: finalizeUsage(acc) };
      };
      return await fn(chat);
    } finally {
      await fs.rm(chatCwd, { recursive: true, force: true });
    }
  };

  /** 对一个 PR 跑评审微流程（共用 enqueue 队列 / 持久化 / 步骤广播）。 */
  const runReviewForPr = (
    pr: StoredPullRequest,
    agentContext: AgentContext,
    chat: AgentChat,
  ): Promise<AgentSession> => {
    const agentCfg = bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentReview(pr, {
      stateStore,
      // 编排派发的 run 走 agent 低优先级泳道：用户随时点 /review 会插到它们之前。
      enqueueRun: (p, tool, question) => enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      matchedRule,
      language: getMainLanguage(),
      // 工具目录注入：修改类工具按 grants 门控（默认全禁，红线见 buildToolCatalog）。
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      maxFollowupAsks: agentCfg.autopilot.max_followup_asks,
      summaryMaxChars: agentCfg.summary_max_chars,
      onStep: (sessionId, step) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('agent:stepProgress', { sessionId, prLocalId: pr.localId, step });
        }
      },
    });
  };

  ipcMain.handle(
    'agent:run',
    async (
      _evt,
      req: IpcChannels['agent:run']['request'],
    ): Promise<IpcChannels['agent:run']['response']> => {
      if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
      const agentCfg = bootstrap.config.agent;
      if (!agentCfg.enabled || !agentCfg.dir) throw new Error(t('prAgent.agentNotEnabled'));
      const pr = await findPrOrThrow(req.localId);
      // 现读现装配 Agent 上下文（SOUL/AGENTS/MEMORY/USER + rules），无缓存。
      const agentContext = await loadAgentContext(agentCfg.dir, {
        onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
      });
      return withAgentChat((chat) => runReviewForPr(pr, agentContext, chat));
    },
  );

  // 自由规划 Agent（自然语言入口）：每 PR 至多一个在跑，AbortController 供 agent:stop 暂停。
  const agentControllers = new Map<string, AbortController>();

  const runPlanningForPr = (
    pr: StoredPullRequest,
    userRequest: string,
    agentContext: AgentContext,
    chat: AgentChat,
    signal: AbortSignal,
  ): Promise<AgentSession> => {
    const agentCfg = bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentPlanning(pr, userRequest, {
      stateStore,
      enqueueRun: (p, tool, question) => enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      matchedRule,
      language: getMainLanguage(),
      maxSteps: agentCfg.max_steps,
      signal,
      onStep: (sessionId, step) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('agent:stepProgress', { sessionId, prLocalId: pr.localId, step });
        }
      },
    });
  };

  ipcMain.handle(
    'agent:ask',
    async (
      _evt,
      req: IpcChannels['agent:ask']['request'],
    ): Promise<IpcChannels['agent:ask']['response']> => {
      if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
      const agentCfg = bootstrap.config.agent;
      if (!agentCfg.enabled || !agentCfg.dir) throw new Error(t('prAgent.agentNotEnabled'));
      const pr = await findPrOrThrow(req.localId);
      const agentContext = await loadAgentContext(agentCfg.dir, {
        onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
      });
      const ac = new AbortController();
      agentControllers.set(pr.localId, ac);
      try {
        return await withAgentChat((chat) =>
          runPlanningForPr(pr, req.question, agentContext, chat, ac.signal),
        );
      } finally {
        agentControllers.delete(pr.localId);
      }
    },
  );

  ipcMain.handle(
    'agent:stop',
    (_evt, req: IpcChannels['agent:stop']['request']): IpcChannels['agent:stop']['response'] => {
      const ac = agentControllers.get(req.localId);
      if (!ac) return { ok: false };
      ac.abort();
      return { ok: true };
    },
  );

  // === AutoPilot 调度（见 docs/arch/06-agent.md「AutoPilot」）===
  // Agent 编排层全局单并发：一次只跑一遍 pass（busy 锁）；其派发的工具 run 在共享队列并行。
  // 由 poller onTick 触发（见 index.ts），最小间隔守卫 + 台账去重防止打爆 LLM。
  let autopilotBusy = false;
  let lastAutopilotEvalAt = 0;
  const runAutopilotIfDue = (): void => {
    const agentCfg = bootstrap.config.agent;
    const ap = agentCfg.autopilot;
    if (!agentCfg.enabled || !agentCfg.dir || !ap.enabled || autopilotBusy || !getPrAgentBridge()) {
      return;
    }
    const now = Date.now();
    if (now - lastAutopilotEvalAt < ap.min_interval_seconds * 1000) return; // 最小间隔守卫
    lastAutopilotEvalAt = now;
    autopilotBusy = true;
    void (async () => {
      try {
        // 候选：未自动评审过当前版本的 PR（台账去重），按 batch_size 截断。
        const prs = await listStoredPullRequests(stateStore);
        const candidates: StoredPullRequest[] = [];
        for (const pr of prs) {
          if (candidates.length >= ap.batch_size) break;
          if (await needsAutoReview(stateStore, pr.localId, pr.updatedAt)) candidates.push(pr);
        }
        if (candidates.length === 0) return;

        const agentContext = await loadAgentContext(agentCfg.dir, {
          onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
        });
        await withAgentChat(async (chat) => {
          // 批量判定（例外规则来自 AGENTS.md）。
          const { decisions } = await judgeAutopilotBatch(chat, {
            candidates: candidates.map((p) => ({
              prLocalId: p.localId,
              title: p.title,
              description: p.description,
            })),
            agentsRules: agentContext.files.agents,
          });
          const byId = new Map(candidates.map((p) => [p.localId, p] as const));
          for (const d of decisions) {
            const pr = byId.get(d.prLocalId);
            if (!pr) continue;
            const at = new Date().toISOString();
            if (!d.review) {
              await writeAutopilotLedger(stateStore, {
                prLocalId: pr.localId,
                autoReviewedUpdatedAt: pr.updatedAt,
                decision: 'skipped',
                reason: d.reason,
                at,
              });
              continue;
            }
            // 单并发：逐 PR 顺序跑编排（工具 run 在共享队列并行消化）。
            const session = await runReviewForPr(pr, agentContext, chat);
            await writeAutopilotLedger(stateStore, {
              prLocalId: pr.localId,
              autoReviewedUpdatedAt: pr.updatedAt,
              decision: 'review',
              recommendation: session.recommendation?.verdict,
              at,
            });
          }
        });
        logger.info({ candidates: candidates.length }, 'autopilot pass done');
      } catch (err) {
        logger.warn({ err }, 'autopilot pass failed (ignored)');
      } finally {
        autopilotBusy = false;
      }
    })();
  };

  ipcMain.handle(
    'pragent:cancel',
    async (
      _evt,
      req: IpcChannels['pragent:cancel']['request'],
    ): Promise<IpcChannels['pragent:cancel']['response']> => {
      // active 命中 → SIGKILL (finally 会写 cancelled 到 disk)
      const running = active.get(req.runId);
      if (running) {
        logger.info({ runId: req.runId }, 'pragent run cancel: active');
        running.ac?.abort();
        return { ok: true };
      }
      // waiting 命中 → 从队列删除 + reject 原 Promise，不写盘 (从未真正跑过)
      const idx = waiting.findIndex((q) => q.info.runId === req.runId);
      if (idx >= 0) {
        const [removed] = waiting.splice(idx, 1);
        logger.info({ runId: req.runId, queueLen: waiting.length }, 'pragent run cancel: queued');
        removed!.reject(new Error('queued run cancelled'));
        broadcastQueueChanged();
        return { ok: true };
      }
      return { ok: false };
    },
  );

  ipcMain.handle('pragent:queue', (): IpcChannels['pragent:queue']['response'] => ({
    active: [...active.values()].map((q) => q.info),
    waiting: waiting.map((q) => q.info),
  }));

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
    ): Promise<IpcChannels['pragent:clearRuns']['response']> => ({
      cleared: await clearReviewRunsForPr(stateStore, req.localId),
    }),
  );

  // === M4 草稿 IPC ===
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
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === pr.connectionId,
      )?.adapter;
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
    'config:setLanguage',
    async (_evt, req: IpcChannels['config:setLanguage']['request']): Promise<void> => {
      const next = { ...bootstrap.config, language: req.language };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存同步 + 主进程 i18n 即时切换（新 dialog/错误文案与下次 pragent:run 的响应语言随之）。
      bootstrap.config.language = req.language;
      setMainLanguage(req.language);
      logger.info({ language: req.language }, 'language config updated');
    },
  );

  ipcMain.handle(
    'config:setAgent',
    async (_evt, req: IpcChannels['config:setAgent']['request']): Promise<void> => {
      const next = { ...bootstrap.config, agent: req.agent };
      await writeConfig(bootstrap.paths.configFile, next);
      bootstrap.config.agent = req.agent;
      logger.info({ agent: req.agent }, 'agent config updated');
    },
  );

  ipcMain.handle(
    'agent:setAutopilotEnabled',
    async (_evt, req: IpcChannels['agent:setAutopilotEnabled']['request']): Promise<void> => {
      const agent = {
        ...bootstrap.config.agent,
        autopilot: { ...bootstrap.config.agent.autopilot, enabled: req.enabled },
      };
      await writeConfig(bootstrap.paths.configFile, { ...bootstrap.config, agent });
      bootstrap.config.agent = agent;
      logger.info({ enabled: req.enabled }, 'autopilot toggled');
    },
  );

  ipcMain.handle(
    'agent:autopilotLedgers',
    async (
      _evt,
      req: IpcChannels['agent:autopilotLedgers']['request'],
    ): Promise<IpcChannels['agent:autopilotLedgers']['response']> => {
      const out: Record<string, AgentRecommendationVerdict> = {};
      for (const id of req.localIds) {
        const ledger = await getAutopilotLedger(stateStore, id);
        if (ledger?.decision === 'review' && ledger.recommendation) {
          out[id] = ledger.recommendation;
        }
      }
      return out;
    },
  );

  ipcMain.handle(
    'rules:matchForPr',
    async (
      _evt,
      req: IpcChannels['rules:matchForPr']['request'],
    ): Promise<IpcChannels['rules:matchForPr']['response']> => {
      const cfg = bootstrap.config.agent;
      if (!cfg.enabled || !cfg.dir) return null;
      // ask 工具不接规则 (问答自由形式，没什么"规约"可应用)
      if (req.tool === 'ask') return null;
      const pr = await findPrOrThrow(req.localId);
      const rules = await loadAgentRules(cfg.dir, {
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

  ipcMain.handle(
    'config:setConnections',
    async (_evt, req: IpcChannels['config:setConnections']['request']): Promise<void> => {
      const next = {
        ...bootstrap.config,
        connections: req.connections,
        active_connection_id: req.active_connection_id,
      };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存 config 同步 + 热重建 adapter/poller，连接变更即时生效（不等重启）
      bootstrap.config.connections = req.connections;
      bootstrap.config.active_connection_id = req.active_connection_id;
      await reconfigureConnections();
      // 立刻 poll 一轮，让启用 / 切换的连接 PR 马上出现（active 为空则空操作）
      void poller.tick();
      logger.info(
        { count: req.connections.length, activeId: req.active_connection_id },
        'connections config updated (hot-reloaded)',
      );
    },
  );

  ipcMain.handle(
    'config:setProxy',
    async (_evt, req: IpcChannels['config:setProxy']['request']): Promise<void> => {
      const next = { ...bootstrap.config, proxy: req.proxy };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存同步 + 热重建 adapter（REST fetch 用上新代理）；git/pr-agent 出口读最新配置无需重建
      bootstrap.config.proxy = req.proxy;
      await reconfigureConnections();
      logger.info(
        { enabled: req.proxy.enabled, host: req.proxy.host, port: req.proxy.port },
        'proxy config updated (hot-reloaded)',
      );
    },
  );

  ipcMain.handle(
    'config:testProxy',
    async (
      _evt,
      req: IpcChannels['config:testProxy']['request'],
    ): Promise<IpcChannels['config:testProxy']['response']> => {
      return testProxyConnectivity(req.proxy);
    },
  );

  ipcMain.handle(
    'config:testConnection',
    async (
      _evt,
      req: IpcChannels['config:testConnection']['request'],
    ): Promise<IpcChannels['config:testConnection']['response']> => {
      // 用草稿 url/token 临时起 adapter ping，不落配置；失败归一成 ok:false + reason
      try {
        return await buildDraftAdapter(
          req.base_url,
          req.token,
          bootstrap.config.proxy,
          req.kind,
        ).ping();
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'config:autosaveDraft',
    async (_evt, req: IpcChannels['config:autosaveDraft']['request']): Promise<void> => {
      // 只写 config.yaml（含 base 非编辑字段），**不更新内存 config、不 reconfigure**：
      // 持久化防丢失但不生效。重启读文件 或 点底栏「保存」走 config:setConnections/setLlm 才应用。
      const next = {
        ...bootstrap.config,
        connections: req.connections,
        active_connection_id: req.active_connection_id,
        llm: req.llm,
      };
      await writeConfig(bootstrap.paths.configFile, next);
      logger.info(
        { connections: req.connections.length, profiles: req.llm.profiles.length },
        'connections/llm draft autosaved to config.yaml (not applied)',
      );
    },
  );

  ipcMain.handle(
    'config:setPoller',
    async (_evt, req: IpcChannels['config:setPoller']['request']): Promise<void> => {
      // 防御性 clamp 到 60~900 整数（UI 已限制，这里兜底）
      const seconds = Math.min(900, Math.max(60, Math.round(req.interval_seconds)));
      const next = {
        ...bootstrap.config,
        poller: { ...bootstrap.config.poller, interval_seconds: seconds },
      };
      await writeConfig(bootstrap.paths.configFile, next);
      bootstrap.config.poller.interval_seconds = seconds;
      poller.setIntervalSeconds(seconds); // 热替换定时器，无需重启
      logger.info({ intervalSeconds: seconds }, 'poller interval updated (hot-reloaded)');
    },
  );

  logger.debug('IPC handlers registered');

  return {
    /**
     * 应用退出时调用：中止所有进行中的 run。每个 run 的 AbortController.abort() 会触发 exec 的
     * onAbort → killTree（进程树级杀），连带终止 python 及其 litellm 等孙进程，避免孤儿进程锁住
     * 安装目录导致升级安装失败。返回被中止的 run 数，供调用方决定是否需要短暂等待 taskkill 跑完。
     */
    abortAllActiveRuns: () => {
      let n = 0;
      for (const item of active.values()) {
        item.ac?.abort();
        n++;
      }
      return n;
    },
    /** 每次 poll tick 由 index.ts 调用：满足开关 + 最小间隔 + 候选时跑一遍 AutoPilot pass。 */
    runAutopilotIfDue,
  };
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
// litellm usage 哨兵行前缀（与 sitecustomize.py 的 _emit 保持一致）。
const USAGE_SENTINEL = '@@MEEBOX_USAGE@@';

interface UsageAcc {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  any: boolean;
}

/**
 * 解析一行 stderr：若含 usage 哨兵（`@@MEEBOX_USAGE@@ {json}`，sitecustomize 注入）则累加到
 * acc 并返回 true（调用方据此吞掉该行、不转发给 renderer / 不入日志）。普通行返回 false。
 * 坏 JSON 也返回 true（仍吞掉，避免漏进实时日志），只是不计数。容错优先。
 */
function accumulateUsageSentinel(line: string, acc: UsageAcc): boolean {
  const i = line.indexOf(USAGE_SENTINEL);
  if (i < 0) return false;
  try {
    const r = JSON.parse(line.slice(i + USAGE_SENTINEL.length).trim()) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    acc.calls += 1;
    if (typeof r.prompt_tokens === 'number') {
      acc.prompt += r.prompt_tokens;
      acc.any = true;
    }
    if (typeof r.completion_tokens === 'number') {
      acc.completion += r.completion_tokens;
      acc.any = true;
    }
    if (typeof r.total_tokens === 'number') {
      acc.total += r.total_tokens;
      acc.any = true;
    }
  } catch {
    // 坏哨兵行：仍吞掉，不计数
  }
  return true;
}

/** 累加器 → TokenUsage；无任何有效数据返回 undefined（未捕获到，如非 embedded / 流式 / 未调 LLM）。 */
function finalizeUsage(acc: UsageAcc): TokenUsage | undefined {
  if (!acc.any) return undefined;
  return {
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    // 优先各次 total 累加；个别次缺 total 时用 prompt+completion 兜底
    totalTokens: acc.total || acc.prompt + acc.completion,
    calls: acc.calls,
  };
}

/**
 * 持久化前从 stderr 去掉 usage 哨兵行：onLine 实时已拦截不转发，但 exec 内部把全量 stderr
 * 累加进 result.stderr（含哨兵），落盘前清掉这些噪声行。
 */
function stripUsageSentinels(stderr: string | undefined): string | undefined {
  if (!stderr) return stderr;
  return stderr
    .split('\n')
    .filter((l) => !l.includes(USAGE_SENTINEL))
    .join('\n');
}

function languageDirectiveFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return 'Respond in Simplified Chinese (简体中文). All section labels, table headers, column names, headings, and content MUST be in Chinese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return 'Respond in Traditional Chinese (繁體中文). All section labels, table headers, column names, headings, and content MUST be in Chinese.';
  }
  if (norm.startsWith('ja')) {
    return 'Respond in Japanese (日本語). All section labels, table headers, column names, headings, and content MUST be in Japanese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('de')) {
    return 'Respond in German (Deutsch). All section labels, table headers, column names, headings, and content MUST be in German — do not leave any English template strings untranslated.';
  }
  return '';
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
  // 单活动连接模型：状态栏只展示当前活动连接的启用状态（与 poller 只轮询活动连接一致）。
  const activeId = bootstrap.config.active_connection_id;
  return adapters
    .filter(({ connectionId }) => connectionId === activeId)
    .map(({ connectionId, adapter }) => {
      const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
      return {
        connectionId,
        displayName: conn?.display_name ?? connectionId,
        user: adapter.getCurrentUser(),
        capabilities: adapter.capabilities(),
      };
    });
}
