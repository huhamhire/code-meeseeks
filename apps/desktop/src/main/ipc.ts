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
  listReviewRunsForPr,
  listStoredPullRequests,
  parseReviewOutput,
  setLocalStatus,
  startReviewRun,
} from '@pr-pilot/poller';
import type { RepoIdentity, RepoMirrorManager } from '@pr-pilot/repo-mirror';
import type {
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
  const findPrOrThrow = async (localId: string): Promise<StoredPullRequest> => {
    const prs = await listStoredPullRequests(stateStore);
    const pr = prs.find((p) => p.localId === localId);
    if (!pr) throw new Error(`PR not found in local state: ${localId}`);
    return pr;
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

  ipcMain.handle(
    'repo:sync',
    async (
      _evt,
      req: IpcChannels['repo:sync']['request'],
    ): Promise<IpcChannels['repo:sync']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const r = await repoMirror.syncMirror(repoIdentityFor(pr));
      return { mirrorPath: r.mirrorPath, freshClone: r.freshClone };
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
      // 自动先 sync，再算 diff。renderer 不需要额外协调。
      await repoMirror.syncMirror(id);
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
    'diff:listComments',
    async (
      _evt,
      req: IpcChannels['diff:listComments']['request'],
    ): Promise<IpcChannels['diff:listComments']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      const adapter = adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;
      if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
      return adapter.listPullRequestComments(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
      );
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
      const pr = await findPrOrThrow(req.localId);
      const run = await startReviewRun(stateStore, {
        prLocalId: pr.localId,
        tool: req.tool,
        prAgentVersion: prAgentBridge.version,
        strategy: prAgentBridge.strategy,
      });
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
      try {
        const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
        // LLM env + 全局 pr-agent 配置 (响应语言)。语言配置一期写死在 config 里，
        // UI 还不暴露切换；后续多语言时改成 Settings 入口
        const env: Record<string, string> = {
          ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
          CONFIG__RESPONSE_LANGUAGE: bootstrap.config.language,
        };
        const result = await prAgentBridge.run({
          prUrl: pr.url,
          tool: req.tool,
          env,
          onLine,
          cwd: wt.path,
          targetBranch: wt.targetBranchName,
        });
        // pr-agent 的 local provider 把生成结果**写到工作树根的 markdown 文件**：
        //   /describe → <wt>/description.md
        //   /review   → <wt>/review.md
        // stdout 只有 INFO 级别日志，没有真正的 PR 描述 / review 输出。
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
        const parsed = parseReviewOutput(fileContent || result.stdout, req.tool);
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
          const status: ReviewRunStatus = 'failed';
          logger.warn(
            { runId: run.id, reason: err.reason, exitCode: err.result.exitCode },
            'pragent run failed',
          );
          // 失败时也尽量解析已收集的 stdout：很多情况 pr-agent 已写了一部分输出
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
    },
  );

  ipcMain.handle(
    'pragent:listRuns',
    async (
      _evt,
      req: IpcChannels['pragent:listRuns']['request'],
    ): Promise<IpcChannels['pragent:listRuns']['response']> =>
      listReviewRunsForPr(stateStore, req.localId),
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
