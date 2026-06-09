import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStateStore } from '@meebox/state-store';
import {
  finishReviewRun,
  getReviewRun,
  listReviewRunsForPr,
  makeRunId,
  startReviewRun,
} from '../src/runs.js';

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
  it('格式 yyyymmdd-HHmmss-mmm', () => {
    const id = makeRunId(new Date('2026-05-29T10:20:30.045Z'));
    // 转换到本地时区会影响 HH，但是字符长度和分隔符稳定
    expect(id).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
  it('字典序 = 时间序，便于列名倒排出最新', () => {
    const a = makeRunId(new Date('2026-05-29T10:00:00.000Z'));
    const b = makeRunId(new Date('2026-05-29T11:00:00.000Z'));
    expect(a < b).toBe(true);
  });
});

describe('startReviewRun', () => {
  it('落地 running 状态 + 必备字段', async () => {
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

    // 文件确实落到 prs/<localId>/runs/<runId>.json
    const fp = path.join(tmpRoot, 'prs', 'abc123def456', 'runs', `${run.id}.json`);
    const txt = await fs.readFile(fp, 'utf8');
    expect(JSON.parse(txt).run.id).toBe(run.id);
  });
});

describe('finishReviewRun', () => {
  it('merge patch 到已有 run，保留 startedAt 等字段', async () => {
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

  it('文件不存在返回 null（不会静默重建）', async () => {
    const r = await finishReviewRun(store, 'abc123def456', 'nonexistent', {
      status: 'succeeded',
      finishedAt: 'x',
      durationMs: 1,
    });
    expect(r).toBeNull();
  });

  it('失败原因 + exitCode + stderr 都能写入', async () => {
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
  it('找不到时返回 null', async () => {
    const r = await getReviewRun(store, 'abc123def456', 'nope');
    expect(r).toBeNull();
  });
});

describe('listReviewRunsForPr', () => {
  it('newest first，跨 PR 不串扰', async () => {
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
    // 另一个 PR 的 run 不应出现在 42 的列表里
    await startReviewRun(
      store,
      { prLocalId: 'def789abc012', tool: 'review', prAgentVersion: 'v', strategy: 'embedded' },
      () => new Date('2026-05-29T10:30:00.000Z'),
    );
    const list = await listReviewRunsForPr(store, 'abc123def456');
    expect(list.map((r) => r.id)).toEqual([newA.id, oldA.id]);
    expect(list.map((r) => r.tool)).toEqual(['describe', 'review']);
  });

  it('无 run 时返回空数组', async () => {
    const list = await listReviewRunsForPr(store, 'abc123def456');
    expect(list).toEqual([]);
  });
});
