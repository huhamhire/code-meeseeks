import { app, BrowserWindow, ipcMain, shell } from 'electron';
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

      // 1) 磁盘 cache 命中且未过期？
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
          logger.debug(
            { hash, ageMs: age, slug: req.slug, bytes: bytes.length },
            'avatar served from disk cache',
          );
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
    ): Promise<IpcChannels['prs:setLocalStatus']['response']> =>
      setLocalStatus(stateStore, req.localId, req.status),
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

      try {
        const result = await prAgentBridge.run({
          prUrl: pr.url,
          tool: req.tool,
          // M3-B1 暂不读 config.llm；pr-agent 自己从 process.env 取 OPENAI_API_KEY 等。
          //   M3-C 接入完整 LLM Provider 配置 → buildPragentEnv(bootstrap.config) 注入
          onLine,
        });
        const parsed = parseReviewOutput(result.stdout, req.tool);
        return await finishWith({
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: result.exitCode,
          stdout: result.stdout,
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

/** 按文件头魔数嗅探常见图片格式；嗅不出退到 octet-stream（浏览器仍可能解码 PNG） */
function sniffImageContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // SVG / XML 以 '<' 起；blame avatar 应该不会出 SVG 但兜底
  if (bytes.length >= 1 && bytes[0] === 0x3c) {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
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
