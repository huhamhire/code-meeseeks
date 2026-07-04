import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import { matchSupportedLanguage, type SupportedLanguage } from '@meebox/shared';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';
import jaJP from './locales/ja-JP.json';
import deDE from './locales/de-DE.json';

/**
 * Main process i18n (standalone i18next instance, pure Node, no React).
 *
 * - Holds its own copy of resources separate from the renderer: main's user-facing text
 *   (dialog titles, error messages thrown to the renderer and ultimately shown in toast/UI)
 *   goes through here.
 * - Language is fixed once at startup by `bootstrap.config.language` (`initMainI18n`).
 *   Main process text does not switch live with settings—changing the language takes effect
 *   after restart, fitting the nature of main process text.
 * - key naming follows the "area namespace" convention: dialog / prAgent / drafts / proxy / update.
 */

const instance: I18n = createInstance();

// Currently effective language: fixed by initMainI18n (the passed value is already the effective
// result resolved by resolveLanguage). Reused to keep pr-agent response language
// (CONFIG__RESPONSE_LANGUAGE) etc. consistent with the UI.
let currentLanguage: SupportedLanguage = 'en-US';

/** Main process currently effective language, reused for pr-agent response language etc., kept consistent with the UI. */
export function getMainLanguage(): SupportedLanguage {
  return currentLanguage;
}

/** Called once at startup: initialize main process i18n with the resolved effective language (result of resolveLanguage). */
export function initMainI18n(language: string): void {
  currentLanguage = matchSupportedLanguage(language) ?? 'en-US';
  void instance.init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
      'ja-JP': { translation: jaJP },
      'de-DE': { translation: deDE },
    },
    lng: currentLanguage,
    // Fallback to en-US (i18n standard, consistent with the renderer): missing key falls back to English rather than Chinese.
    fallbackLng: 'en-US',
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

/**
 * Switch the main process language at runtime (called when changing language live from settings /
 * first-run wizard). All locales are statically bundled, so changeLanguage takes effect synchronously;
 * updates currentLanguage in sync so getMainLanguage() (pr-agent response language) follows.
 * Already-shown dialogs are not retroactively updated; newly produced text and the next run use the new language.
 */
export function setMainLanguage(language: string): void {
  currentLanguage = matchSupportedLanguage(language) ?? 'en-US';
  void instance.changeLanguage(currentLanguage);
}

/** Main process translation function. Degrades to returning the key before init (no throw, keeps it robust). */
export const t: TFunction = ((key: string, options?: Record<string, unknown>) =>
  instance.isInitialized ? instance.t(key, options) : key) as TFunction;

export default instance;
