/**
 * pr-agent 输出模板的翻译（独立于 react-i18next 的 UI 文案）。
 *
 * 背景：`CONFIG__RESPONSE_LANGUAGE=zh-CN` 只影响 LLM 生成的**内容值**，但 pr-agent
 * 在其 Python 源码里**硬编码**了一批结构化模板字符串（section 标题 / fixed labels /
 * checkbox 文字），这些 LLM 不动它们，所以中文环境下仍以英文出现。我们在渲染层做一次
 * 替换，把已知模板词翻成目标语言。
 *
 * 这不是「按 key 取串」而是「按英文原文匹配、整段 blob 子串替换」，与 react-i18next 的
 * 访问模型不同，故**不进 locale 资源**，各语言的 <英文模板 → 译文> 表独立维护在同目录
 * 的 `pr-agent-labels/<lang>.json`，由本文件的替换引擎加载。
 *
 * 字典随 pr-agent 版本维护（按输出模板分组、便于跟上游升级 spot-check；JSON 顺序不影响
 * 正确性——引擎按 key 长度倒序处理，避免"短键先吃掉长键的子串"）。pr-agent v0.36 把
 * issue_header "Possible bug" rewrite 成大写 I 的 "Possible Issue" 绕过 LLM 翻译，故字典
 * 里另列了大写版本。
 *
 * 语言感知：仅当 UI 语言 (config.language) 有对应字典（当前 zh-CN）时替换；en-US 等无字典
 * 语言下 pr-agent 输出本就是英文，原样返回 (passthrough)。新增目标语言 = 加一份
 * `pr-agent-labels/<lang>.json` 并在 TRANSLATION_MAPS 注册。
 */

import i18n, { normalizeLanguage, type SupportedLanguage } from '../i18n';
import zhCN from './pr-agent-labels/zh-CN.json';

// 各语言的 <英文模板 → 译文> 表注册表。未注册的语言（如 en-US）→ passthrough。
const TRANSLATION_MAPS: Partial<Record<SupportedLanguage, Record<string, string>>> = {
  'zh-CN': zhCN,
};

// 按语言缓存「预排序条目」(长 key 在前，避免短 key 先吃掉长 key 的子串)
const SORTED_BY_LANG = new Map<SupportedLanguage, Array<[string, string]>>();
function sortedEntriesFor(lang: SupportedLanguage): Array<[string, string]> | null {
  const map = TRANSLATION_MAPS[lang];
  if (!map) return null;
  let cached = SORTED_BY_LANG.get(lang);
  if (!cached) {
    cached = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
    SORTED_BY_LANG.set(lang, cached);
  }
  return cached;
}

/**
 * 把含 pr-agent 模板英文标签的字符串按当前 UI 语言翻译。
 * - 替换是字面量 (split/join)，不走正则，避免特殊字符意外匹配。
 * - 大小写敏感：模板里都是首字母大写，保持原样。
 * - 当前语言无对应字典 (如 en-US) 时原样返回 (pr-agent 输出本就是英文)。
 */
export function translatePrAgentLabels(text: string): string {
  if (!text) return text;
  const entries = sortedEntriesFor(normalizeLanguage(i18n.language));
  if (!entries) return text;
  let result = text;
  for (const [en, zh] of entries) {
    if (result.includes(en)) {
      result = result.split(en).join(zh);
    }
  }
  return result;
}
