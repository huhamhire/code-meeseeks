import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { StateStore } from '@meebox/state-store';
import { resolveCodexExecutable, REVIEW_FEATURE_FLAGS } from './codex-review.js';

type CatalogModel = { id: string; label: string };
type CodexExecutable = NonNullable<Awaited<ReturnType<typeof resolveCodexExecutable>>>;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_KEY = 'codex/model-catalog';
const MAX_CLI_CACHE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
type CatalogSnapshot = { models: CatalogModel[]; expiresAt: number };
let cached: CatalogSnapshot | undefined;
let hydration: Promise<void> | undefined;
let pending: Promise<CatalogModel[]> | undefined;

function normalizeModel(id: unknown, displayName: unknown): CatalogModel | undefined {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(id)) return;
  const label = typeof displayName === 'string' ? displayName.slice(0, 120) : id;
  return { id, label: label || id };
}

async function readCliCache(): Promise<CatalogModel[]> {
  try {
    const file = path.resolve(
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'models_cache.json',
    );
    const stats = await stat(file);
    if (!stats.isFile() || stats.size > MAX_CLI_CACHE_BYTES) return [];
    const data = JSON.parse(await readFile(file, 'utf8')) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
        input_modalities?: unknown;
      } | null>;
    } | null;
    const models = new Map<string, CatalogModel>();
    for (const entry of Array.isArray(data?.models) ? data.models : []) {
      if (
        entry?.visibility !== 'list' ||
        (Array.isArray(entry.input_modalities) && !entry.input_modalities.includes('text'))
      )
        continue;
      const model = normalizeModel(entry.slug, entry.display_name);
      if (model) models.set(model.id, model);
    }
    return [...models.values()];
  } catch {
    return [];
  }
}

export async function getCachedCodexModels(store: StateStore): Promise<CatalogModel[]> {
  if (!hydration) {
    hydration = (async () => {
      const snapshot = await store.read<CatalogSnapshot>(CACHE_KEY).catch(() => null);
      const models = Array.isArray(snapshot?.models)
        ? snapshot.models.flatMap((entry) => normalizeModel(entry?.id, entry?.label) ?? [])
        : [];
      const expiresAt = snapshot?.expiresAt ?? 0;
      cached = models.length
        ? { models, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 }
        : { models: await readCliCache(), expiresAt: 0 };
    })();
  }
  await hydration;
  return cached?.models ?? [];
}

export async function listCodexModels(
  store: StateStore,
  env: Record<string, string> = {},
  readyRuntime?: CodexExecutable,
): Promise<CatalogModel[]> {
  await getCachedCodexModels(store);
  if (pending) return pending;
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  pending = (async () => {
    const executable = readyRuntime ?? (await resolveCodexExecutable());
    if (!executable) throw new Error('Codex executable was not found');
    const models = await readCatalog(executable, env);
    if (!models.length) throw new Error('Codex returned no selectable models');
    cached = { models, expiresAt: Date.now() + CACHE_TTL_MS };
    await store.write(CACHE_KEY, cached).catch(() => {});
    return models;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

function readCatalog(
  runtime: CodexExecutable,
  env: Record<string, string>,
): Promise<CatalogModel[]> {
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
          const model = normalizeModel(entry.model, entry.displayName);
          if (model) models.set(model.id, model);
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
