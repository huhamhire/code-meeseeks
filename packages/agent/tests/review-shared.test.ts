import { describe, expect, it } from 'vitest';
import { compactDescribe } from '../src/steps/review/shared.js';

describe('compactDescribe', () => {
  it('strips the File Walkthrough <details> block (through to the end)', () => {
    const text = [
      '### Title',
      'Add auth guard',
      '',
      '<details><summary><h3>File Walkthrough</h3></summary>',
      '<table><tr><td>src/a.ts</td></tr></table>',
      '</details>',
    ].join('\n');
    const out = compactDescribe(text);
    expect(out).toContain('Add auth guard');
    expect(out).not.toContain('File Walkthrough');
    expect(out).not.toContain('src/a.ts');
  });

  it('strips mermaid code blocks, keeps the rest of the body', () => {
    const text = [
      '## Summary',
      'Refactor cache.',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      '## Type',
      'Enhancement',
    ].join('\n');
    const out = compactDescribe(text);
    expect(out).toContain('Refactor cache.');
    expect(out).toContain('Enhancement');
    expect(out).not.toContain('mermaid');
    expect(out).not.toContain('graph TD');
  });

  it('returns as-is when there is nothing to strip (only trims leading/trailing whitespace)', () => {
    const text = '## Summary\nLooks good.';
    expect(compactDescribe(text)).toBe('## Summary\nLooks good.');
  });
});
