import { spawn } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { discoverCodexReview, REVIEW_FEATURE_FLAGS } from './codex-review.js';

type CatalogModel = { id: string; label: string };
type ReadyRuntime = Extract<
  Awaited<ReturnType<typeof discoverCodexReview>>,
  { status: 'ready' }
>['runtime'];
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
let cached: { models: CatalogModel[]; expiresAt: number } | undefined;
let pending: Promise<CatalogModel[]> | undefined;

export function listCodexModels(env: Record<string, string> = {}): Promise<CatalogModel[]> {
  if (pending) return pending;
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.models);
  pending = (async () => {
    const discovery = await discoverCodexReview();
    if (discovery.status !== 'ready') throw new Error('Codex is not ready');
    const models = await readCatalog(discovery.runtime, env);
    cached = { models, expiresAt: Date.now() + CACHE_TTL_MS };
    return models;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

function readCatalog(runtime: ReadyRuntime, env: Record<string, string>): Promise<CatalogModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runtime.command,
      [...runtime.prefix, ...REVIEW_FEATURE_FLAGS, 'app-server', '--stdio'],
      {
        cwd: os.tmpdir(),
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const models = new Map<string, CatalogModel>();
    let done = false;
    let requestId = 1;
    const seenCursors = new Set<string>();
    const timer = setTimeout(
      () => finish(new Error('Codex catalog request timed out')),
      REQUEST_TIMEOUT_MS,
    );

    function finish(error?: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      const stop = setTimeout(() => {
        child.kill();
      }, 1500);
      stop.unref();
      child.once('close', () => clearTimeout(stop));
      if (error) reject(error);
      else resolve([...models.values()]);
    }

    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const requestPage = (cursor?: string) => {
      send({
        method: 'model/list',
        id: ++requestId,
        params: { limit: 100, includeHidden: false, cursor },
      });
    };
    child.once('error', () => finish(new Error('Could not launch Codex catalog process')));
    child.once('close', () => finish(new Error('Codex catalog process ended early')));
    child.stdin.on('error', () => finish(new Error('Could not send Codex catalog request')));
    lines.on('line', (line) => {
      if (done) return;
      try {
        const reply = JSON.parse(line) as {
          id?: number;
          error?: unknown;
          result?: { data?: unknown[]; nextCursor?: string | null };
        };
        if (reply.id !== requestId) return;
        if (reply.error || !reply.result) throw new Error('Codex catalog request failed');
        if (requestId === 1) {
          send({ method: 'initialized' });
          requestPage();
          return;
        }
        if (!Array.isArray(reply.result.data)) throw new Error('Unexpected Codex catalog response');
        for (const raw of reply.result.data) {
          const entry = raw as {
            model?: unknown;
            displayName?: unknown;
            hidden?: boolean;
            inputModalities?: string[];
          };
          if (
            entry.hidden ||
            (Array.isArray(entry.inputModalities) && !entry.inputModalities.includes('text'))
          )
            continue;
          if (
            typeof entry.model !== 'string' ||
            !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(entry.model)
          )
            continue;
          const label =
            typeof entry.displayName === 'string' ? entry.displayName.slice(0, 120) : entry.model;
          models.set(entry.model, { id: entry.model, label: label || entry.model });
        }
        const cursor = reply.result.nextCursor;
        if (cursor && seenCursors.size < 5 && !seenCursors.has(cursor)) {
          seenCursors.add(cursor);
          requestPage(cursor);
          return;
        }
        finish();
      } catch {
        finish(new Error('Could not read Codex model catalog'));
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'code-meeseeks', title: 'Code Meeseeks', version: '0.1.0' } },
    });
  });
}
