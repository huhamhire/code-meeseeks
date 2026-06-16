import { describe, expect, it, vi } from 'vitest';
import {
  extractJson,
  runReviewMicroflow,
  salvageProse,
  stripTrailingJson,
} from '../src/orchestrator.js';
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

  it('recovers JSON with unescaped raw newlines inside string values', () => {
    // 模型常把多行 markdown 原样塞进字符串值、不转义换行——补转义后应能解析。
    const raw = '{"final": "## 摘要\n\n第一行\n第二行", "recommendation": {"verdict": "needs_work"}}';
    const parsed = extractJson<{ final: string; recommendation: { verdict: string } }>(raw);
    expect(parsed?.final).toBe('## 摘要\n\n第一行\n第二行');
    expect(parsed?.recommendation.verdict).toBe('needs_work');
  });
});

describe('salvageProse', () => {
  it('extracts the final/summary prose from an unparseable JSON action', () => {
    // 截断（无闭合 } / 引号）时仍捞出散文，绝不把原始 JSON 丢给用户。
    const truncated = '{"thought":"t","final":"## 摘要\\n\\n本 PR 修复了空值崩溃';
    expect(salvageProse(truncated)).toBe('## 摘要\n\n本 PR 修复了空值崩溃');
    expect(salvageProse('{"summary":"all good"}')).toBe('all good');
  });

  it('falls back to trimmed raw text when no prose field is present', () => {
    expect(salvageProse('  just text  ')).toBe('just text');
  });
});

describe('stripTrailingJson', () => {
  it('strips a trailing recommendation JSON block the model wrongly appended', () => {
    const fenced = '## 摘要\n\n本 PR 修复了空值崩溃。\n\n```json\n{"recommendation": {"verdict": "needs_work"}}\n```';
    expect(stripTrailingJson(fenced)).toBe('## 摘要\n\n本 PR 修复了空值崩溃。');
    const bare = '## 摘要\n\n本 PR 修复了空值崩溃。\n\n{\n  "recommendation": {"verdict": "approve"}\n}';
    expect(stripTrailingJson(bare)).toBe('## 摘要\n\n本 PR 修复了空值崩溃。');
  });

  it('leaves legitimate trailing JSON / braces untouched', () => {
    const code = '说明：配置形如 `{ "port": 8080 }`，按需调整。';
    expect(stripTrailingJson(code)).toBe(code);
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
    // 类 Claude Code：一条思考步（plan，承载 describe+review 选择）→ judge → 收尾 plan；
    // describe/review/ask 的执行由 run 卡片代表、不再补记 tool 步。
    expect(r.steps.map((s) => s.kind)).toEqual(['plan', 'judge', 'plan']);
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
    expect(askCalls.map((c) => c.question)).toEqual(['q1', 'q2']); // capped at 2（执行经 runTool / run 卡片）
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
    expect(seen).toEqual(['plan', 'judge', 'plan']);
  });
});
