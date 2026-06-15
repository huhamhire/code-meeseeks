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
});
