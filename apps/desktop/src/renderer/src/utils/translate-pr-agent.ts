/**
 * Translation of pr-agent output templates (independent of react-i18next's UI text).
 *
 * Background: `CONFIG__RESPONSE_LANGUAGE=zh-CN` only affects the **content values** the LLM generates, but pr-agent
 * **hardcodes** a batch of structured template strings in its Python source (section headings / fixed labels /
 * checkbox text) that the LLM leaves untouched, so under a Chinese environment they still appear in English. We do one
 * pass of replacement in the renderer, translating known template words into the target language.
 *
 * This is not "look up a string by key" but "match by English source, substring-replace across the whole blob", which
 * differs from react-i18next's access model, so it **does not go into locale resources**; each language's
 * <English template → translation> table is maintained separately in `pr-agent-labels/<lang>.json` in the same
 * directory, loaded by this file's replacement engine.
 *
 * The dictionary is maintained per pr-agent version (grouped by output template, to ease spot-checking against upstream
 * upgrades; JSON order does not affect correctness — the engine processes keys in descending length order, avoiding
 * "a short key eating the substring of a long key"). pr-agent v0.36 rewrote the issue_header "Possible bug" into
 * "Possible Issue" with an uppercase I to bypass LLM translation, so the dictionary also lists the uppercase version.
 *
 * Language-aware: replaces only when the UI language (config.language) has a matching dictionary (currently zh-CN);
 * under dictionary-less languages like en-US the pr-agent output is already English, returned as-is (passthrough).
 * Adding a target language = add a `pr-agent-labels/<lang>.json` and register it in TRANSLATION_MAPS.
 */

import i18n, { matchSupportedLanguage, type SupportedLanguage } from '../i18n';
import zhCN from './pr-agent-labels/zh-CN.json';
import jaJP from './pr-agent-labels/ja-JP.json';
import deDE from './pr-agent-labels/de-DE.json';

// Registry of each language's <English template → translation> table. Unregistered languages (e.g. en-US) → passthrough.
const TRANSLATION_MAPS: Partial<Record<SupportedLanguage, Record<string, string>>> = {
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'de-DE': deDE,
};

// Cache "pre-sorted entries" per language (long keys first, to avoid a short key eating a long key's substring)
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
 * Translate a string containing pr-agent template English labels according to the current UI language.
 * - Replacement is literal (split/join), not regex, to avoid accidental matches on special characters.
 * - Case-sensitive: templates are all title-cased, kept as-is.
 * - When the current language has no matching dictionary (e.g. en-US) returns as-is (pr-agent output is already English).
 */
export function translatePrAgentLabels(text: string): string {
  if (!text) return text;
  const lang = matchSupportedLanguage(i18n.language);
  const entries = lang ? sortedEntriesFor(lang) : null;
  if (!entries) return text;
  let result = text;
  for (const [en, zh] of entries) {
    if (result.includes(en)) {
      result = result.split(en).join(zh);
    }
  }
  return result;
}
