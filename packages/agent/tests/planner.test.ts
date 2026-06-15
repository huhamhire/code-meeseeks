import { describe, expect, it, vi } from 'vitest';
import { runPlanningAgent, type PlanningDeps } from '../src/planner.js';
import { buildToolCatalog } from '../src/tool-catalog.js';
import type { AgentContext } from '../src/types.js';

const context: AgentContext = {
  files: { soul: 's', agents: 'a', memory: '', user: '' },
  rules: [],
};
const pr = { title: 'T', targetBranch: 'main' };
const catalog = buildToolCatalog(); // read 可用、修改类禁用

function makeDeps(
  chatReplies: string[],
  toolText: Record<string, string> = {},
): { deps: PlanningDeps; toolCalls: Array<{ tool: string; question?: string }> } {
  const toolCalls: Array<{ tool: string; question?: string }> = [];
  let i = 0;
  const deps: PlanningDeps = {
    chat: vi.fn(async () => ({
      text: chatReplies[i++] ?? '{"final":"done"}',
      usage: { totalTokens: 5 },
    })),
    runTool: vi.fn(async (call: { tool: string; question?: string }) => {
      toolCalls.push(call);
      return { text: toolText[call.tool] ?? `${call.tool}-result`, usage: { totalTokens: 10 } };
    }),
  };
  return { deps, toolCalls };
}

describe('runPlanningAgent', () => {
  it('dispatches a tool then finishes; accumulates usage', async () => {
    const { deps, toolCalls } = makeDeps([
      '{"thought":"review it","tool":"/review"}',
      '{"thought":"done","final":"LGTM"}',
    ]);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog,
      userRequest: 'check this',
    });
    expect(toolCalls.map((c) => c.tool)).toEqual(['/review']);
    expect(r.finalText).toBe('LGTM');
    expect(r.steps.map((s) => s.kind)).toEqual(['tool', 'plan']);
    expect(r.tokenUsage.totalTokens).toBe(20); // 2 chat(5) + 1 tool(10)
  });

  it('dispatches multiple read-only tools in one turn (parallel) then finishes', async () => {
    const { deps, toolCalls } = makeDeps([
      '{"thought":"need both","tools":["/describe","/review"]}',
      '{"final":"done"}',
    ]);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog,
      userRequest: 'summary and review',
    });
    expect(toolCalls.map((c) => c.tool)).toEqual(['/describe', '/review']);
    // 两个工具步骤 + 收尾 plan
    expect(r.steps.map((s) => s.kind)).toEqual(['tool', 'tool', 'plan']);
    expect(r.finalText).toBe('done');
  });

  it('runs allowed tools and refuses disallowed ones within the same multi-tool turn', async () => {
    const { deps, toolCalls } = makeDeps([
      '{"tools":["/review","/approve"]}',
      '{"final":"ok"}',
    ]);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog, // /approve 未授权
      userRequest: 'x',
    });
    expect(toolCalls.map((c) => c.tool)).toEqual(['/review']); // 仅允许的被分发
    expect(r.steps.some((s) => s.kind === 'judge')).toBe(true); // /approve 被拒记录
  });

  it('caps parallel tool selection at 3', async () => {
    const { deps, toolCalls } = makeDeps([
      '{"tools":["/review","/review","/review","/review"]}',
      '{"final":"ok"}',
    ]);
    await runPlanningAgent(deps, { context, pr, toolCatalog: catalog, userRequest: 'x' });
    expect(toolCalls).toHaveLength(3); // 4 选 → 截断为 3
  });

  it('refuses ungranted mutating tools (red line) and lets the agent re-plan', async () => {
    const { deps, toolCalls } = makeDeps(['{"tool":"/approve"}', '{"final":"cannot approve"}']);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog,
      userRequest: 'approve it',
    });
    expect(toolCalls).toHaveLength(0); // /approve never dispatched
    expect(r.steps[0]?.kind).toBe('judge'); // refusal recorded
    expect(r.finalText).toBe('cannot approve');
  });

  it('allows a granted mutating tool', async () => {
    const { deps, toolCalls } = makeDeps(['{"tool":"/approve"}', '{"final":"approved"}']);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: buildToolCatalog(['approve']),
      userRequest: 'approve',
    });
    expect(toolCalls.map((c) => c.tool)).toEqual(['/approve']);
    expect(r.finalText).toBe('approved');
  });

  it('stops at maxSteps', async () => {
    const { deps } = makeDeps(['{"tool":"/review"}', '{"tool":"/review"}', '{"tool":"/review"}']);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog,
      userRequest: 'loop',
      maxSteps: 2,
    });
    expect(r.terminationReason).toBe('步数上限中止');
  });

  it('stops immediately when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps } = makeDeps(['{"tool":"/review"}']);
    const r = await runPlanningAgent(
      { ...deps, signal: ac.signal },
      { context, pr, toolCatalog: catalog, userRequest: 'x' },
    );
    expect(r.terminationReason).toBe('用户暂停');
    expect(r.steps).toHaveLength(0);
  });

  it('returns a structured recommendation when the review close includes one', async () => {
    const { deps } = makeDeps([
      '{"final":"## 摘要\\n...","recommendation":{"verdict":"needs_work","reason":"fix log key"}}',
    ]);
    const r = await runPlanningAgent(deps, {
      context,
      pr,
      toolCatalog: catalog,
      userRequest: 'review',
    });
    expect(r.recommendation).toEqual({ verdict: 'needs_work', reason: 'fix log key' });
  });

  it('ignores an invalid / missing verdict (no recommendation forced)', async () => {
    const { deps } = makeDeps(['{"final":"answer","recommendation":{"verdict":"lgtm"}}']);
    const r = await runPlanningAgent(deps, { context, pr, toolCatalog: catalog, userRequest: 'x' });
    expect(r.recommendation).toBeUndefined();
  });

  it('treats unparseable output as a final answer', async () => {
    const { deps } = makeDeps(['just some text, no json']);
    const r = await runPlanningAgent(deps, { context, pr, toolCatalog: catalog, userRequest: 'x' });
    expect(r.finalText).toBe('just some text, no json');
  });

  it('injects the routing policy (PR-content → /ask fallback, unrelated → decline) into the system prompt', async () => {
    const { deps } = makeDeps(['{"final":"done"}']);
    await runPlanningAgent(deps, { context, pr, toolCatalog: catalog, userRequest: 'x' });
    const system = vi.mocked(deps.chat).mock.calls[0]?.[0]?.system ?? '';
    expect(system).toContain('default to /ask');
    expect(system).toContain('unrelated to this PR');
  });
});
