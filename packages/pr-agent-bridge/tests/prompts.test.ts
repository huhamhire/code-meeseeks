import { describe, expect, it } from 'vitest';
import { stripAskQuestionEcho } from '../src/prompts.js';

describe('stripAskQuestionEcho', () => {
  it('按 pr-agent 的 Answer 表头切，丢弃问题回显 + 注入的格式指令（含字面示例标签）', () => {
    // pr-agent `_prepare_pr_answer` 产物形态：Ask 段回显问题 + 我们拼进问题的结构化指令（含示例
    // <summary> 标签），Answer 段才是真答案。结构化解析须只见到答案，否则会误把示例标签当答案。
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
    // 示例 <summary> 标签（问题回显里的）已被切掉，只剩答案里的那一个。
    expect(out.match(/<summary>/g)?.length).toBe(1);
  });

  it('无 Answer 表头（版本漂移）→ 回退逐行精确删问题 / 语言后缀', () => {
    const md = ['这个函数有什么问题？', '答案正文。', '请用简体中文回答。'].join('\n');
    const out = stripAskQuestionEcho(md, '这个函数有什么问题？', '请用简体中文回答。');
    expect(out).toBe('答案正文。');
  });

  it('空输入安全返回', () => {
    expect(stripAskQuestionEcho('', 'q')).toBe('');
  });
});
