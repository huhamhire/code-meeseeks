import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStateStore } from '@meebox/state-store';
import {
  clearReviewRunsForPr,
  deleteReviewRun,
  finishReviewRun,
  getReviewRun,
  hasReviewOutput,
  listFileChangeDescriptions,
  listReviewRunsForPr,
  makeRunId,
  startReviewRun,
} from '../src/runs.js';
import { createDraft, dropPendingFindingDrafts, listDrafts, updateDraft } from '../src/drafts.js';

let tmpRoot: string;
let store: JsonFileStateStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-runs-'));
  store = new JsonFileStateStore(tmpRoot);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('makeRunId', () => {
  it('format yyyymmdd-HHmmss-mmm', () => {
    const id = makeRunId(new Date('2026-05-29T10:20:30.045Z'));
    // converting to local timezone affects HH, but character length and separators stay stable
    expect(id).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
  it('lexical order = time order, so reverse-sorting names surfaces the latest', () => {
    const a = makeRunId(new Date('2026-05-29T10:00:00.000Z'));
    const b = makeRunId(new Date('2026-05-29T11:00:00.000Z'));
    expect(a < b).toBe(true);
  });
});

describe('startReviewRun', () => {
  it('persists running status + required fields', async () => {
    const now = new Date('2026-05-29T10:00:00.000Z');
    const run = await startReviewRun(
      store,
      {
        prLocalId: 'abc123def456',
        tool: 'review',
        prAgentVersion: 'pr-agent 0.36.0',
        strategy: 'local-cli',
      },
      () => now,
    );
    expect(run.status).toBe('running');
    expect(run.startedAt).toBe(now.toISOString());
    expect(run.tool).toBe('review');
    expect(run.prAgentVersion).toBe('pr-agent 0.36.0');
    expect(run.strategy).toBe('local-cli');
    expect(run.finishedAt).toBeUndefined();

    // file actually lands at prs/<localId>/runs/<runId>.json
    const fp = path.join(tmpRoot, 'prs', 'abc123def456', 'runs', `${run.id}.json`);
    const txt = await fs.readFile(fp, 'utf8');
    expect(JSON.parse(txt).run.id).toBe(run.id);
  });
});

describe('finishReviewRun', () => {
  it('merge patches into an existing run, preserving startedAt and other fields', async () => {
    const start = new Date('2026-05-29T10:00:00.000Z');
    const run = await startReviewRun(
      store,
      {
        prLocalId: 'abc123def456',
        tool: 'review',
        prAgentVersion: 'v',
        strategy: 'embedded',
      },
      () => start,
    );
    const finished = await finishReviewRun(store, 'abc123def456', run.id, {
      status: 'succeeded',
      finishedAt: '2026-05-29T10:02:00.000Z',
      durationMs: 120_000,
      exitCode: 0,
      stdout: '## Review\n...',
    });
    expect(finished?.status).toBe('succeeded');
    expect(finished?.startedAt).toBe(start.toISOString());
    expect(finished?.durationMs).toBe(120_000);
    expect(finished?.stdout).toContain('Review');
  });

  it('returns null when the file does not exist (no silent recreate)', async () => {
    const r = await finishReviewRun(store, 'abc123def456', 'nonexistent', {
      status: 'succeeded',
      finishedAt: 'x',
      durationMs: 1,
    });
    expect(r).toBeNull();
  });

  it('writes error reason + exitCode + stderr', async () => {
    const run = await startReviewRun(store, {
      prLocalId: 'abc123def456',
      tool: 'review',
      prAgentVersion: 'v',
      strategy: 'embedded',
    });
    const finished = await finishReviewRun(store, 'abc123def456', run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: 30_000,
      errorReason: 'timeout',
      errorMessage: 'pr-agent timed out after 30000ms',
      stderr: '...timeout details...',
    });
    expect(finished?.status).toBe('failed');
    expect(finished?.errorReason).toBe('timeout');
    expect(finished?.errorMessage).toContain('timed out');
  });
});

describe('getReviewRun', () => {
  it('returns null when not found', async () => {
    const r = await getReviewRun(store, 'abc123def456', 'nope');
    expect(r).toBeNull();
  });
});

describe('hasReviewOutput', () => {
  const pr = 'abc123def456';
  const startWith = (tool: 'describe' | 'review' | 'ask', at: Date) =>
    startReviewRun(
      store,
      { prLocalId: pr, tool, prAgentVersion: 'v', strategy: 'embedded' },
      () => at,
    );

  it('no run → false', async () => {
    expect(await hasReviewOutput(store, pr)).toBe(false);
  });

  it('describe / review succeeded → true', async () => {
    const r = await startWith('describe', new Date('2026-05-29T10:00:00.000Z'));
    await finishReviewRun(store, pr, r.id, { status: 'succeeded', finishedAt: 'x', durationMs: 1 });
    expect(await hasReviewOutput(store, pr)).toBe(true);
  });

  it('review in progress (running) → true', async () => {
    await startWith('review', new Date('2026-05-29T10:00:00.000Z'));
    expect(await hasReviewOutput(store, pr)).toBe(true);
  });

  it('describe/review failed / cancelled does not count, still triggerable → false', async () => {
    const a = await startWith('describe', new Date('2026-05-29T10:00:00.000Z'));
    await finishReviewRun(store, pr, a.id, { status: 'failed', finishedAt: 'x', durationMs: 1 });
    const b = await startWith('review', new Date('2026-05-29T10:01:00.000Z'));
    await finishReviewRun(store, pr, b.id, { status: 'cancelled', finishedAt: 'x', durationMs: 1 });
    expect(await hasReviewOutput(store, pr)).toBe(false);
  });

  it('/ask succeeding alone does not count as "reviewed" → false', async () => {
    const r = await startWith('ask', new Date('2026-05-29T10:00:00.000Z'));
    await finishReviewRun(store, pr, r.id, { status: 'succeeded', finishedAt: 'x', durationMs: 1 });
    expect(await hasReviewOutput(store, pr)).toBe(false);
  });
});

describe('listReviewRunsForPr', () => {
  it('cleans file-led bullets from saved descriptions on both history reads', async () => {
    const prLocalId = 'abc123def456';
    const id = 'legacy-describe';
    await startReviewRun(store, { id, prLocalId, tool: 'describe' });
    await finishReviewRun(store, prLocalId, id, {
      status: 'succeeded',
      finishedAt: '2026-11-24T00:00:00.000Z',
      durationMs: 1,
      findings: [
        {
          id: 'description',
          category: 'description',
          title: 'Description',
          body: '- Show pending imports.\n- `src/import.ts` updates the polling interval.',
        },
      ],
    });
    expect((await getReviewRun(store, prLocalId, id))?.findings?.[0]?.body).toBe(
      '- Show pending imports.',
    );
    expect((await listReviewRunsForPr(store, prLocalId))[0]?.findings?.[0]?.body).toBe(
      '- Show pending imports.',
    );
  });

  it('finds the latest successful description for the exact PR or commit comparison', async () => {
    const prLocalId = 'abc123def456';
    const scope = { parent: 'parent', sha: 'commit', abbreviatedSha: 'commit', subject: 'Test' };
    const snapshots = [
      { id: '01', baseSha: 'base', headSha: 'head', summary: 'First' },
      { id: '02', baseSha: 'base', headSha: 'head', summary: 'Latest' },
      { id: '03', baseSha: 'new-base', headSha: 'head', summary: 'Different base' },
      { id: '04', baseSha: 'base', headSha: 'new-head', summary: 'Different head' },
      { id: '05', baseSha: 'base', headSha: 'new-head', summary: 'Commit scope', scope },
    ];
    for (const { summary, ...snapshot } of snapshots) {
      await startReviewRun(store, { ...snapshot, prLocalId, tool: 'describe' });
      await finishReviewRun(store, prLocalId, snapshot.id, {
        status: 'succeeded',
        finishedAt: '2026-11-24T00:00:00.000Z',
        durationMs: 1,
        stdout:
          '<details><summary><h3>File Walkthrough</h3></summary>\n' +
          `<tr><td><strong>a.ts</strong><dd><code>${summary}</code></dd></td><td><a href="meebox:///src/a.ts">+2/-1</a></td></tr>\n</details>`,
      });
    }
    await startReviewRun(store, {
      id: '06',
      prLocalId,
      tool: 'describe',
      baseSha: 'base',
      headSha: 'head',
    });
    expect(
      await listFileChangeDescriptions(store, prLocalId, {
        base: 'base',
        head: 'head',
        commit: false,
      }),
    ).toEqual([{ path: 'src/a.ts', summary: 'Latest' }]);
    expect(
      await listFileChangeDescriptions(store, prLocalId, {
        base: 'parent',
        head: 'commit',
        commit: true,
      }),
    ).toEqual([{ path: 'src/a.ts', summary: 'Commit scope' }]);
    expect(
      await listFileChangeDescriptions(store, prLocalId, {
        base: 'parent',
        head: 'commit',
        commit: false,
      }),
    ).toEqual([]);
  });

  it('keeps Codex runs and drafts outside PR Agent history and cleanup', async () => {
    const prLocalId = 'abc123def456';
    const native = await startReviewRun(store, {
      id: '20261119-100000-001',
      prLocalId,
      tool: 'review',
      engine: 'codex',
    });
    expect(await hasReviewOutput(store, prLocalId)).toBe(false);
    const standard = await startReviewRun(store, {
      id: '20261119-100000-000',
      prLocalId,
      tool: 'review',
      prAgentVersion: '0.50.0',
      strategy: 'embedded',
    });
    const page = await listReviewRunsForPr(store, prLocalId, { engine: 'pr-agent', limit: 1 });
    expect(page.map((run) => run.id)).toEqual([standard.id]);
    for (const run of [native, standard]) {
      await createDraft(store, prLocalId, {
        origin: 'finding',
        source: { runId: run.id, findingId: 'finding', engine: run.engine },
        body: 'Finding',
        status: 'pending',
      });
    }
    expect(await dropPendingFindingDrafts(store, prLocalId)).toBe(1);
    expect((await listDrafts(store, prLocalId)).map((draft) => draft.source?.runId)).toEqual([
      native.id,
    ]);
    expect(await clearReviewRunsForPr(store, prLocalId)).toBe(1);
    expect((await getReviewRun(store, prLocalId, native.id))?.engine).toBe('codex');
  });

  it('scopes individual reads and deletes to the requested engine and PR', async () => {
    const pr = 'abc123def456';
    const legacy = await startReviewRun(store, { id: 'legacy', prLocalId: pr, tool: 'review' });
    const codex = await startReviewRun(store, {
      id: 'native',
      prLocalId: pr,
      tool: 'ask',
      engine: 'codex',
    });

    expect(await getReviewRun(store, pr, legacy.id, 'codex')).toBeNull();
    expect(await getReviewRun(store, pr, codex.id, 'pr-agent')).toBeNull();
    expect(await getReviewRun(store, 'other-pr', codex.id, 'codex')).toBeNull();
    expect(await deleteReviewRun(store, pr, legacy.id, 'codex')).toBe(false);
    expect(await deleteReviewRun(store, pr, codex.id, 'pr-agent')).toBe(false);
    expect(await deleteReviewRun(store, 'other-pr', codex.id, 'codex')).toBe(false);
    expect((await getReviewRun(store, pr, legacy.id, 'pr-agent'))?.id).toBe(legacy.id);
    expect((await getReviewRun(store, pr, codex.id, 'codex'))?.id).toBe(codex.id);
    expect(await deleteReviewRun(store, pr, legacy.id, 'pr-agent')).toBe(true);
    expect(await deleteReviewRun(store, pr, codex.id, 'codex')).toBe(true);
  });

  it('keeps pending drafts from the current and newer review during cleanup', async () => {
    const pr = 'abc123def456';
    for (const runId of ['20261119-100000-000', '20261119-100000-001', '20261119-100000-002']) {
      await createDraft(store, pr, {
        origin: 'finding',
        source: { runId, findingId: 'finding', engine: 'pr-agent' },
        body: 'Finding',
        status: 'pending',
      });
    }
    expect(await dropPendingFindingDrafts(store, pr, '20261119-100000-001')).toBe(1);
    expect((await listDrafts(store, pr)).map((draft) => draft.source?.runId)).toEqual([
      '20261119-100000-001',
      '20261119-100000-002',
    ]);
  });

  it('preserves a draft edit started before review cleanup', async () => {
    const pr = 'abc123def456';
    const draft = await createDraft(store, pr, {
      origin: 'finding',
      source: { runId: '20261119-100000-000', findingId: 'finding', engine: 'pr-agent' },
      body: 'Finding',
      status: 'pending',
    });
    const [, dropped] = await Promise.all([
      updateDraft(store, pr, draft.id, { body: 'Edited finding' }),
      dropPendingFindingDrafts(store, pr, '20261119-100000-001'),
    ]);
    expect(dropped).toBe(0);
    expect(await listDrafts(store, pr)).toMatchObject([
      { body: 'Edited finding', status: 'edited' },
    ]);
  });

  it('newest first, no cross-PR bleed', async () => {
    const oldA = await startReviewRun(
      store,
      { prLocalId: 'abc123def456', tool: 'review', prAgentVersion: 'v', strategy: 'embedded' },
      () => new Date('2026-05-29T09:00:00.000Z'),
    );
    const newA = await startReviewRun(
      store,
      { prLocalId: 'abc123def456', tool: 'describe', prAgentVersion: 'v', strategy: 'embedded' },
      () => new Date('2026-05-29T11:00:00.000Z'),
    );
    // another PR's run should not appear in 42's list
    await startReviewRun(
      store,
      { prLocalId: 'def789abc012', tool: 'review', prAgentVersion: 'v', strategy: 'embedded' },
      () => new Date('2026-05-29T10:30:00.000Z'),
    );
    const list = await listReviewRunsForPr(store, 'abc123def456');
    expect(list.map((r) => r.id)).toEqual([newA.id, oldA.id]);
    expect(list.map((r) => r.tool)).toEqual(['describe', 'review']);
  });

  it('returns an empty array when there is no run', async () => {
    const list = await listReviewRunsForPr(store, 'abc123def456');
    expect(list).toEqual([]);
  });
});
