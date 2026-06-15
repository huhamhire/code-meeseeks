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

  it('treats unparseable output as a final answer', async () => {
    const { deps } = makeDeps(['just some text, no json']);
    const r = await runPlanningAgent(deps, { context, pr, toolCatalog: catalog, userRequest: 'x' });
    expect(r.finalText).toBe('just some text, no json');
  });
});
