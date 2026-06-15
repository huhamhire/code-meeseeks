import { describe, expect, it } from 'vitest';
import { assembleSystemContext } from '../src/assemble.js';
import type { ToolCatalogEntry } from '@meebox/shared';
import type { AgentContext } from '../src/types.js';

const emptyContext: AgentContext = {
  files: { soul: '', agents: '', memory: '', user: '' },
  rules: [],
};

const tools: ToolCatalogEntry[] = [
  { name: '/review', summary: 'Generate review findings', mutating: false, enabled: true },
  { name: '/approve', summary: 'Approve the PR', mutating: true, enabled: false },
];

const pr = { title: 'Fix login bug', targetBranch: 'main', changeSummary: '3 files, +20/-5' };

describe('assembleSystemContext', () => {
  it('orders sections per §2 and skips empty ones', () => {
    const out = assembleSystemContext({
      context: {
        files: { soul: 'I am soul', agents: 'work rules', memory: '', user: 'prefers terse' },
        rules: [],
      },
      pr,
      toolCatalog: tools,
      language: 'zh-CN',
    });

    // SOUL before AGENTS before tools before PR before language
    expect(out.indexOf('# Soul')).toBeLessThan(out.indexOf('# Working agreement'));
    expect(out.indexOf('# Working agreement')).toBeLessThan(out.indexOf('# Available tools'));
    expect(out.indexOf('# Available tools')).toBeLessThan(out.indexOf('# Current PR'));
    expect(out.indexOf('# Current PR')).toBeLessThan(out.indexOf('# Output & memory language'));
    // empty memory section is skipped, present user section is kept
    expect(out).not.toContain('# Memory');
    expect(out).toContain('# User profile');
  });

  it('marks mutating/disabled tools in the catalog', () => {
    const out = assembleSystemContext({ context: emptyContext, pr, toolCatalog: tools });
    expect(out).toContain('`/review` — Generate review findings');
    expect(out).toContain('`/approve`');
    expect(out).toContain('mutating');
    expect(out).toContain('requires explicit authorization');
  });

  it('emits the language directive for output and memory writes; defaults to en-US', () => {
    const zh = assembleSystemContext({ context: emptyContext, pr, toolCatalog: [], language: 'zh-CN' });
    expect(zh).toContain('Respond to the user in zh-CN');
    expect(zh).toContain('MEMORY.md / USER.md');

    const def = assembleSystemContext({ context: emptyContext, pr, toolCatalog: [] });
    expect(def).toContain('Respond to the user in en-US');
  });

  it('renders the session snapshot when provided', () => {
    const out = assembleSystemContext({
      context: emptyContext,
      pr,
      toolCatalog: [],
      session: { todo: [{ id: '1', text: 'run review', done: false }], progressNote: 'started' },
    });
    expect(out).toContain('# Current session');
    expect(out).toContain('- [ ] run review');
    expect(out).toContain('started');
  });
});
