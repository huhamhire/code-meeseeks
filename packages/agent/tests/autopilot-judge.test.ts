import { describe, expect, it, vi } from 'vitest';
import { judgeAutopilotBatch } from '../src/autopilot-judge.js';

describe('judgeAutopilotBatch', () => {
  it('returns empty for no candidates without calling chat', async () => {
    const chat = vi.fn();
    const r = await judgeAutopilotBatch(chat, { candidates: [] });
    expect(r.decisions).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('parses per-PR decisions and carries usage', async () => {
    const chat = vi.fn(async () => ({
      text: '```json\n{"decisions": [{"prLocalId":"a","review":true,"reason":"real change"},{"prLocalId":"b","review":false,"reason":"branch merge"}]}\n```',
      usage: { totalTokens: 12 },
    }));
    const r = await judgeAutopilotBatch(chat, {
      candidates: [
        { prLocalId: 'a', title: 'Fix bug' },
        { prLocalId: 'b', title: 'Merge main' },
      ],
    });
    expect(r.decisions).toEqual([
      { prLocalId: 'a', review: true, reason: 'real change' },
      { prLocalId: 'b', review: false, reason: 'branch merge' },
    ]);
    expect(r.usage?.totalTokens).toBe(12);
  });

  it('defaults unparsed candidates to review (conservative)', async () => {
    const chat = vi.fn(async () => ({ text: 'not json' }));
    const r = await judgeAutopilotBatch(chat, { candidates: [{ prLocalId: 'x', title: 'T' }] });
    expect(r.decisions).toEqual([{ prLocalId: 'x', review: true, reason: 'default (unparsed)' }]);
  });

  it('includes AGENTS.md rules in the system prompt', async () => {
    let system = '';
    const chat = vi.fn(async (i: { system: string; user: string }) => {
      system = i.system;
      return { text: '{"decisions":[]}' };
    });
    await judgeAutopilotBatch(chat, {
      candidates: [{ prLocalId: 'a', title: 'T' }],
      agentsRules: 'Skip docs-only PRs.',
    });
    expect(system).toContain('Skip docs-only PRs.');
  });

  it('surfaces branch-merge / mainline signals as evidence in the user prompt', async () => {
    let user = '';
    const chat = vi.fn(async (i: { system: string; user: string }) => {
      user = i.user;
      return { text: '{"decisions":[]}' };
    });
    await judgeAutopilotBatch(chat, {
      candidates: [
        {
          prLocalId: 'a',
          title: 'Sync',
          sourceBranch: 'main',
          targetBranch: 'release/1',
          branchMerge: true,
          sourceMainline: true,
        },
        {
          prLocalId: 'b',
          title: 'Feature from fork default branch',
          sourceBranch: 'master',
          targetBranch: 'master',
          branchMerge: false,
          sourceMainline: true,
        },
      ],
    });
    // 分支合并(提交全 merge)给出明确证据；仅源为主干则只标注背景信号、不暗示跳过。
    expect(user).toContain('all commits are merge commits');
    expect(user).toContain('source is a long-lived / integration branch');
    // 旧的硬性「prefer skip」措辞不再出现。
    expect(user).not.toContain('prefer skip');
  });

  it('parses a valid per-PR plan and drops an omitted / invalid one', async () => {
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        decisions: [
          { prLocalId: 'a', review: true, reason: 'config only', plan: ['describe-review', 'summary'] },
          { prLocalId: 'b', review: true, reason: 'invalid', plan: ['summary'] },
          { prLocalId: 'c', review: true, reason: 'no plan' },
        ],
      }),
    }));
    const r = await judgeAutopilotBatch(chat, {
      candidates: [
        { prLocalId: 'a', title: 'A' },
        { prLocalId: 'b', title: 'B' },
        { prLocalId: 'c', title: 'C' },
      ],
    });
    const byId = Object.fromEntries(r.decisions.map((d) => [d.prLocalId, d]));
    expect(byId.a?.plan).toEqual({ steps: ['describe-review', 'summary'] });
    expect(byId.b?.plan).toBeUndefined(); // summary 缺前置 describe-review → 非法回落
    expect(byId.c?.plan).toBeUndefined(); // 省略 → 默认全集
  });
});
