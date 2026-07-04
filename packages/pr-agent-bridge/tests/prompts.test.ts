import { describe, expect, it } from 'vitest';
import { stripAskQuestionEcho } from '../src/prompts.js';

describe('stripAskQuestionEcho', () => {
  it('splits on pr-agent Answer header, dropping question echo + injected format instructions (incl. literal example tags)', () => {
    // pr-agent `_prepare_pr_answer` output shape: the Ask section echoes the question + the structured instructions
    // we appended to it (incl. example <summary> tags), and only the Answer section is the real answer. Structured
    // parsing must see only the answer, otherwise it mistakes the example tags for the answer.
    const md = [
      '### **Ask**❓',
      '这个函数有什么问题？',
      '',
      'STRUCTURE YOUR ANSWER into <summary>...</summary> sections.',
      '  <summary>',
      '  A direct answer (example).',
      '  </summary>',
      '',
      '### **Answer:**',
      '<summary>真正的结论</summary>',
      '<analysis>真正的分析</analysis>',
    ].join('\n');
    const out = stripAskQuestionEcho(md, '这个函数有什么问题？');
    expect(out).toContain('<summary>真正的结论</summary>');
    expect(out).not.toContain('A direct answer (example)');
    expect(out).not.toContain('### **Ask**');
    // The example <summary> tag (from the question echo) has been cut, leaving only the one in the answer.
    expect(out.match(/<summary>/g)?.length).toBe(1);
  });

  it('no Answer header (version drift) → falls back to line-by-line exact removal of question / language suffix', () => {
    const md = ['这个函数有什么问题？', '答案正文。', '请用简体中文回答。'].join('\n');
    const out = stripAskQuestionEcho(md, '这个函数有什么问题？', '请用简体中文回答。');
    expect(out).toBe('答案正文。');
  });

  it('empty input returns safely', () => {
    expect(stripAskQuestionEcho('', 'q')).toBe('');
  });
});
