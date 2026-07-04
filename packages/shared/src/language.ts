/**
 * Language resolution (shared by main / renderer).
 *
 * config.language is the "desired language": if non-empty and supported, use it; if empty (unset = auto), match against the OS
 * preferred languages one by one; if none match, fall back to English (en-US) rather than the source language Chinese — a multilingual product should not force Chinese by default.
 */

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP', 'de-DE'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * UI language options: each language is shown with **its own localized name (endonym)**, not translated by the current UI language
 * (English is always "English", Chinese is always "中文 (简体)").
 *
 * Order: English, as the international lingua franca + current default/fallback language, is **pinned to the top**; the rest follow endonym alphabetical order
 * (Latin names first, CJK after): English → Deutsch → 中文 (简体) → 日本語. The settings page dropdown and
 * the first-launch wizard share this list, staying consistent.
 */
export interface LanguageOption {
  code: SupportedLanguage;
  /** The language's localized name (endonym), used directly as the dropdown item text, not translated via i18n. */
  endonym: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: 'en-US', endonym: 'English' },
  { code: 'de-DE', endonym: 'Deutsch' },
  { code: 'zh-CN', endonym: '中文 (简体)' },
  { code: 'ja-JP', endonym: '日本語' },
];

/** Match any locale string (zh-Hans-CN / en / ja-JP / de-DE…) to a supported language; return null when no match. */
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
 * Resolve the effective UI language: prefer config.language; if empty / unrecognized, match against the OS preferred language list one by one;
 * if still no suitable option, fall back to English (en-US).
 *
 * @param configLang config.language (may be an empty string = auto)
 * @param osLocales  OS preferred language list (renderer passes navigator.languages, main passes
 *                   app.getPreferredSystemLanguages()), ordered by priority
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
