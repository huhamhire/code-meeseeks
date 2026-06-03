/**
 * pr-agent 输出模板的中文翻译字典。
 *
 * 背景：`CONFIG__RESPONSE_LANGUAGE=zh-CN` 只影响 LLM 生成的**内容值**，但 pr-agent
 * 在其 Python 源码里**硬编码**了一批结构化模板字符串（section 标题 / fixed labels /
 * checkbox 文字），这些 LLM 不动它们，所以中文环境下仍以英文出现。
 *
 * 我们在渲染层做一次替换，把已知模板词翻成中文。字典按 pr-agent 0.35.x 实际
 * 输出模板维护：跟上游升级需要 spot-check 一次。
 *
 * 实现：把 `text` 里出现的英文键全部 literal 替换为对应中文。按 key 长度倒序
 * 处理避免"短键先把长键的子串吃掉"——例如先翻译 "PR contains tests" 再翻译 "Tests"，
 * 否则 "PR contains tests" 里的 "tests" 会被先替换成 "测试"，毁掉长 phrase 匹配。
 *
 * 未匹配的英文保持原样 (兜底，确保新版本 pr-agent 多出来的词不被吞)。
 */

export const PR_AGENT_TRANSLATIONS_ZH: ReadonlyMap<string, string> = new Map([
  // /review 结构化标签
  ['PR Reviewer Guide', 'PR 评审导引'],
  [
    'Here are some key observations to aid the review process:',
    '以下是辅助评审的关键观察：',
  ],
  ['Here are some key observations to aid the review process', '以下是辅助评审的关键观察'],
  ['Estimated effort to review', '预估评审工作量'],
  ['Estimated effort to review:', '预估评审工作量：'],
  ['PR contains tests', '已包含测试'],
  ['PR does not contain tests', '未包含测试'],
  ['Recommended focus areas for review', '建议重点评审区域'],
  ['Recommended focus areas for review:', '建议重点评审区域：'],
  ['No security concerns identified', '未发现安全风险'],
  ['Security concerns', '安全关注'],
  ['Major issues detected', '发现重大问题'],
  ['No major issues detected', '未发现重大问题'],
  ['Possible issues', '潜在问题'],
  ['Possible issues:', '潜在问题：'],
  ['Key issues to review', '关键评审要点'],
  ['Relevant tests', '相关测试'],
  // "无相关测试" 系列：pr-agent 在没找到相关测试时回这两条之一，截图里就漏在了原文
  ['No relevant tests found', '未发现相关测试'],
  ['No relevant tests', '无相关测试'],
  ['Code feedback', '代码反馈'],
  ['Suggestions', '建议'],
  ['Score', '评分'],
  ['Ticket compliance analysis', '工单合规分析'],
  // /improve 模板词：标题 / 默认 label / 评分行 / 总结
  ['PR Code Suggestions', 'PR 代码改进建议'],
  ['Code Suggestions', '改进建议'],
  ['Suggestion importance[1-10]:', '重要度（1-10）：'],
  ['Suggestion importance', '重要度'],
  ['Why:', '原因：'],
  ['Possible improvement', '可优化点'],
  ['Possible issue', '潜在问题'],
  ['Improvement', '改进'],
  ['Security', '安全'],
  ['Best practice', '最佳实践'],
  ['Maintainability', '可维护性'],
  ['Readability', '可读性'],
  ['Performance', '性能'],
  ['Error handling', '错误处理'],
  ['Possible bug', '潜在 bug'],
  // pr-agent v0.36 utils.py 硬编码把 issue_header "Possible bug" rewrite 成
  // "Possible Issue" (大写 I)，绕过 LLM 翻译路径 → CONFIG__RESPONSE_LANGUAGE 救
  // 不了它，必须在 translate 字典里手动加大写 I 版本
  ['Possible Issue', '潜在问题'],
  ['Possible Issues', '潜在问题'],
  ['General Suggestion', '一般建议'],
  ['Critical Issue', '严重问题'],
  ['Typo', '拼写'],
  ['Style', '风格'],
  ['Documentation', '文档'],
  // /review code-feedback finding 内嵌 labels (pr-agent 模板每条 finding 的子项标题)
  ['Suggested fix', '建议修复'],
  ['Existing code', '原代码'],
  ['Improved code', '改进代码'],
  ['Why:', '原因：'],
  ['Issue:', '问题：'],
  ['Suggestion:', '建议：'],
  ['Severity:', '严重度：'],
  ['Category:', '类别：'],
  ['File:', '文件：'],
  ['Lines:', '行号：'],
  ['Relevant file:', '相关文件：'],
  ['Relevant lines:', '相关行号：'],
  // /describe 结构化标签
  ['PR Type', '类型'],
  ['Description', '描述'],
  ['Walkthrough', '走查'],
  ['Title', '标题'],
  ['User description', '用户描述'],
  ['Auto-generated', '自动生成'],
  // /ask 结构化标签
  ['Question', '问题'],
  ['Questions', '问题'],
  ['Answer', '回答'],
  ['Answers', '回答'],
  ['Analysis', '分析'],
  // PR Type 取值
  ['Bug fix', '缺陷修复'],
  ['Enhancement', '功能增强'],
  ['Documentation', '文档'],
  ['Refactoring', '重构'],
  ['Performance', '性能'],
  ['Configuration changes', '配置变更'],
  ['Tests', '测试'],
  ['Other', '其他'],
  // 严重度 (短词最后处理，避免误伤上面长 phrase)
  ['High', '高'],
  ['Medium', '中'],
  ['Low', '低'],
]);

// 预排序：长 key 在前，避免短 key 先吃掉长 key 的子串
const SORTED_ENTRIES: Array<[string, string]> = [...PR_AGENT_TRANSLATIONS_ZH.entries()].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * 把含 pr-agent 模板英文标签的字符串翻成中文。
 * 替换是字面量 (split/join)，不走正则，避免特殊字符意外匹配。
 * 大小写敏感：模板里都是首字母大写，保持原样。
 */
export function translatePrAgentLabels(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [en, zh] of SORTED_ENTRIES) {
    if (result.includes(en)) {
      result = result.split(en).join(zh);
    }
  }
  return result;
}
