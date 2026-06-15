import { describe, expect, it, vi } from 'vitest';
import { extractJson, runReviewMicroflow } from '../src/orchestrator.js';
import type { ReviewOrchestratorDeps } from '../src/orchestrator.js';
import type { AgentContext } from '../src/types.js';

const context: AgentContext = {
  files: { soul: 'soul', agents: 'agents', memory: '', user: '' },
  rules: [],
};
const pr = { title: 'Fix bug', targetBranch: 'main' };

/** 可编排的 fake deps：runTool 按 tool 返回固定文本；chat 顺序返回排好的回复。 */
function makeDeps(opts: {
  toolText?: Partial<Record<'describe' | 'review' | 'ask', string>>;
  chatReplies: string[];
}): { deps: ReviewOrchestratorDeps; toolCalls: Array<{ tool: string; question?: string }> } {
  const toolCalls: Array<{ tool: string; question?: string }> = [];
  let chatIdx = 0;
  const deps: ReviewOrchestratorDeps = {
    runTool: vi.fn(async (call: { tool: 'describe' | 'review' | 'ask'; question?: string }) => {
      toolCalls.push(call);
      return { text: opts.toolText?.[call.tool] ?? `${call.tool}-result`, usage: { totalTokens: 10 } };
    }),
    chat: vi.fn(async () => {
      const text = opts.chatReplies[chatIdx++] ?? '{}';
      return { text, usage: { totalTokens: 5 } };
    }),
  };
  return { deps, toolCalls };
}

describe('extractJson', () => {
  it('parses fenced and raw JSON, returns null on garbage', () => {
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson<{ a: number }>('noise {"a":2} tail')).toEqual({ a: 2 });
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('runReviewMicroflow', () => {
  it('runs describe→review→summary with no follow-up when not severe', async () => {
    const { deps, toolCalls } = makeDeps({
      chatReplies: [
        '{"severe": false, "questions": []}',
        '{"summary": "all good", "recommendation": {"verdict": "approve", "reason": "no issues"}}',
      ],
    });
    const r = await runReviewMicroflow(deps, { context, pr });

    expect(toolCalls.map((c) => c.tool)).toEqual(['describe', 'review']);
    expect(r.steps.map((s) => s.kind)).toEqual(['tool', 'tool', 'judge', 'plan']);
    expect(r.summary).toBe('all good');
    expect(r.recommendation).toEqual({ verdict: 'approve', reason: 'no issues' });
    // usage accumulated: 2 tools (10 each) + 2 chats (5 each) = 30
    expect(r.tokenUsage.totalTokens).toBe(30);
    expect(r.tokenUsage.calls).toBe(4);
  });

  it('asks follow-ups only for severe issues, capped at maxFollowupAsks', async () => {
    const { deps, toolCalls } = makeDeps({
      chatReplies: [
        '{"severe": true, "questions": ["q1", "q2", "q3"]}',
        '{"summary": "needs a look", "recommendation": {"verdict": "needs_work", "reason": "risky"}}',
      ],
    });
    const r = await runReviewMicroflow(deps, { context, pr, maxFollowupAsks: 2 });

    const askCalls = toolCalls.filter((c) => c.tool === 'ask');
    expect(askCalls.map((c) => c.question)).toEqual(['q1', 'q2']); // capped at 2
    expect(r.steps.filter((s) => s.toolCall?.tool === '/ask')).toHaveLength(2);
    expect(r.recommendation.verdict).toBe('needs_work');
  });

  it('clamps the summary to summaryMaxChars', async () => {
    const long = 'x'.repeat(500);
    const { deps } = makeDeps({
      chatReplies: [
        '{"severe": false}',
        `{"summary": "${long}", "recommendation": {"verdict": "approve", "reason": "ok"}}`,
      ],
    });
    const r = await runReviewMicroflow(deps, { context, pr, summaryMaxChars: 100 });
    expect(r.summary.length).toBe(100);
  });

  it('falls back to manual_review when the summary JSON is unparseable', async () => {
    const { deps } = makeDeps({
      chatReplies: ['{"severe": false}', 'totally not json'],
    });
    const r = await runReviewMicroflow(deps, { context, pr });
    expect(r.recommendation.verdict).toBe('manual_review');
  });

  it('streams every step via onStep', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      chatReplies: ['{"severe": false}', '{"summary": "s", "recommendation": {"verdict": "approve", "reason": "r"}}'],
    });
    deps.onStep = (step) => {
      seen.push(step.kind);
    };
    await runReviewMicroflow(deps, { context, pr });
    expect(seen).toEqual(['tool', 'tool', 'judge', 'plan']);
  });
});
