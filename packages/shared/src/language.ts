/**
 * 语言解析（main / renderer 共用）。
 *
 * config.language 为「期望语言」：非空且受支持则用它；为空（未设置 = 自动）时按操作系统
 * 偏好语言逐个匹配；都不中则回落英语（en-US），而非源语言中文——多语言产品不应默认强制中文。
 */

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP', 'de-DE'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * UI 语言选择项：每个语言以**自身的本地化名称（endonym）**展示，不随当前 UI 语言翻译
 * （English 永远是 "English"、中文永远是 "中文 (简体)"）。
 *
 * 顺序：English 作为国际化通用语 + 当前默认/兜底语言**优先置顶**；其余按 endonym 字母序
 * （拉丁文名在前，CJK 在后）：English → Deutsch → 中文 (简体) → 日本語。设置页下拉框与
 * 首启向导共用此列表，保持一致。
 */
export interface LanguageOption {
  code: SupportedLanguage;
  /** 该语言的本地化名称（endonym），直接用作下拉项文案，不经 i18n 翻译。 */
  endonym: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: 'en-US', endonym: 'English' },
  { code: 'de-DE', endonym: 'Deutsch' },
  { code: 'zh-CN', endonym: '中文 (简体)' },
  { code: 'ja-JP', endonym: '日本語' },
];

/** 把任意 locale 串（zh-Hans-CN / en / ja-JP / de-DE…）匹配到受支持语言，无匹配返回 null。 */
export function matchSupportedLanguage(lang: string | null | undefined): SupportedLanguage | null {
  const n = (lang ?? '').toLowerCase();
  if (!n) return null;
  if (n.startsWith('zh')) return 'zh-CN';
  if (n.startsWith('en')) return 'en-US';
  if (n.startsWith('ja')) return 'ja-JP';
  if (n.startsWith('de')) return 'de-DE';
  return null;
}

/**
 * 解析有效 UI 语言：优先 config.language；为空 / 不识别则按 OS 偏好语言列表逐个匹配；
 * 仍无合适项则回落英语（en-US）。
 *
 * @param configLang config.language（可能为空字符串 = 自动）
 * @param osLocales  OS 偏好语言列表（renderer 传 navigator.languages，main 传
 *                   app.getPreferredSystemLanguages()），按优先级排列
 */
export function resolveLanguage(
  configLang: string | null | undefined,
  osLocales: readonly string[] = [],
): SupportedLanguage {
  for (const cand of [configLang ?? '', ...osLocales]) {
    const matched = matchSupportedLanguage(cand);
    if (matched) return matched;
  }
  return 'en-US';
}
