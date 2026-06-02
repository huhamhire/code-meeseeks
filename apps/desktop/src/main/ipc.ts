import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { writeConfig, type BootstrapResult } from '@pr-pilot/config';
import { PrAgentRunError, type PrAgentBridge } from '@pr-pilot/pr-agent-bridge';
import {
  type Poller,
  finishReviewRun,
  getReviewRun,
  isCommentsCacheStale,
  listReviewRunsForPr,
  listStoredPullRequests,
  parseReviewOutput,
  readCommentsCache,
  setLocalStatus,
  startReviewRun,
  writeCommentsCache,
} from '@pr-pilot/poller';
import type { RepoIdentity, RepoMirrorManager } from '@pr-pilot/repo-mirror';
import { loadRules, pickMatchingRule } from '@pr-pilot/rules';
import type {
  ActiveRunInfo,
  AppInfo,
  ConnectionSummary,
  IpcChannels,
  PrAgentStatus,
  ReviewRun,
  ReviewRunStatus,
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
  /** 探测可用时的 bridge 实例；不可用 (CLI / Docker 都没有) 为 null */
  prAgentBridge: PrAgentBridge | null;
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
  stateStore,
  poller,
  adapters,
  repoMirror,
}: RegisterDeps): void {
  // === 全局唯一活动 run 跟踪 ===
  //
  // 同时只允许一个 pr-agent 在跑，避免：
  //   - 撞 LLM API rate limit
  //   - 多个 docker run 抢同一 PR 的 worktree (我们 materializeWorktree 是 per-run
  //     创临时目录，所以理论上不会撞；但还是限制为 1，节省 CPU / 显存)
  //   - UI 多个 PR 同时显示 "运行中" 状态难追踪
  //
  // 新 run 进来时 activeRun 非空 → reject。activeRun 启动后写 info，结束 (succeeded
  // / failed / cancelled) 后清空。每次变化都广播 'pragent:activeChanged'，renderer
  // 据此切 UI。AbortController 留给 cancel handler 用。
  let activeRun: { info: ActiveRunInfo; ac: AbortController } | null = null;

  const broadcastActiveChanged = (): void => {
    const payload = { active: activeRun?.info ?? null };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pragent:activeChanged', payload);
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

  ipcMain.handle(
    'diff:listComments',
    async (
      _evt,
      req: IpcChannels['diff:listComments']['request'],
    ): Promise<IpcChannels['diff:listComments']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      // 缓存命中条件：pr_updated_at 跟当前 PR meta updatedAt 一致 → 直接回缓存，
      // 不打远端。PR 任何变更 (新评论 / 状态等) BBS 都会更新 updatedAt，跳变即重拉
      const cache = await readCommentsCache(stateStore, pr.localId);
      if (cache && !isCommentsCacheStale(cache, pr.updatedAt)) {
        return cache.comments;
      }
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      const fresh = await adapter.listPullRequestComments(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
      );
      await writeCommentsCache(stateStore, pr.localId, {
        comments: fresh,
        pr_updated_at: pr.updatedAt,
        fetched_at: new Date().toISOString(),
      });
      return fresh;
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
      // 全局单并发：activeRun 非空时 reject。renderer 应该靠 'pragent:activeChanged'
      // 事件预先禁用 UI，正常用户行为下到不了这里；这条是兜防御
      if (activeRun) {
        throw new Error(
          `已有 pr-agent 运行中 (PR ${activeRun.info.prLocalId} /${activeRun.info.tool})，请等待其结束或主动取消`,
        );
      }
      const pr = await findPrOrThrow(req.localId);
      const run = await startReviewRun(stateStore, {
        prLocalId: pr.localId,
        tool: req.tool,
        question: req.tool === 'ask' ? req.question : undefined,
        prAgentVersion: prAgentBridge.version,
        strategy: prAgentBridge.strategy,
      });
      // 立即占住活动槽位 + 广播。失败 / 完成 / 取消都在最后 finally 清空再广播
      const ac = new AbortController();
      activeRun = {
        info: {
          runId: run.id,
          prLocalId: pr.localId,
          tool: req.tool,
          question: req.tool === 'ask' ? req.question : undefined,
          startedAt: run.startedAt,
        },
        ac,
      };
      broadcastActiveChanged();
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
        // start 之后理论上一定能读到；保险起见 fallback 到内存对象，把 patch 合并上
        return updated ?? { ...run, ...patch };
      };

      // 物化一个临时工作树：HEAD 在命名分支 pr-pilot/head 指向 PR head sha，
      // pr-pilot/base 指向 PR base sha (pr-agent LocalGitProvider 强约束：HEAD 不能
      // detached、LOCAL__TARGET_BRANCH 只能是分支名)。跑完无论成败都清掉。
      // 这条路径 pr-agent 完全不出网到 BBS (除了 LLM API)，不需要 BBS token / VPN / CA
      const repoId = repoIdentityFor(pr);
      await repoMirror.syncMirror(repoId);
      const wt = await repoMirror.materializeWorktree(
        repoId,
        pr.sourceRef.sha,
        pr.targetRef.sha,
      );
      // tool='ask' 的请求必须带 question，否则 pr-agent 启动就会因缺位置参数报错。
      // 早一点 reject，让前端能立即给反馈
      if (req.tool === 'ask' && !req.question?.trim()) {
        throw new Error('/ask 需要提供 question');
      }

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

        const extraParts = [langDirective, prContext, matchedRuleInstructions].filter((s) =>
          s.trim(),
        );
        if (extraParts.length > 0) {
          const envKey =
            req.tool === 'describe'
              ? 'PR_DESCRIPTION__EXTRA_INSTRUCTIONS'
              : req.tool === 'review'
                ? 'PR_REVIEWER__EXTRA_INSTRUCTIONS'
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
        //   /describe → <wt>/description.md          (走 publish_description)
        //   /review   → <wt>/review.md                (走 publish_comment)
        //   /ask     → <wt>/review.md  ← 共用同一文件 (走 publish_comment，会覆盖)
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
        // 释放活动槽位 + 广播；放最后保证 finishReviewRun 已写盘，renderer 收到
        // activeChanged=null 后再 listRuns 能拿到这次 run 的最终状态
        activeRun = null;
        broadcastActiveChanged();
      }
    },
  );

  ipcMain.handle(
    'pragent:cancel',
    async (
      _evt,
      req: IpcChannels['pragent:cancel']['request'],
    ): Promise<IpcChannels['pragent:cancel']['response']> => {
      // runId 不匹配 / 没有活动 run → no-op，让 renderer 不必处理多余 reject
      if (!activeRun || activeRun.info.runId !== req.runId) {
        return { ok: false };
      }
      logger.info({ runId: req.runId }, 'pragent run cancel requested');
      activeRun.ac.abort();
      return { ok: true };
    },
  );

  ipcMain.handle(
    'pragent:active',
    (): IpcChannels['pragent:active']['response'] => activeRun?.info ?? null,
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
