import { describe, expect, it } from 'vitest';
import { compactDescribe } from '../src/steps/review/shared.js';

describe('compactDescribe', () => {
  it('剥掉 File Walkthrough <details> 块（取到结尾）', () => {
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

  it('剥掉 mermaid 代码块，保留其余正文', () => {
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

  it('无可剥块时原样返回（仅去首尾空白）', () => {
    const text = '## Summary\nLooks good.';
    expect(compactDescribe(text)).toBe('## Summary\nLooks good.');
  });
});
