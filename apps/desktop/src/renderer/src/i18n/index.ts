import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import {
  SUPPORTED_LANGUAGES,
  matchSupportedLanguage,
  resolveLanguage,
  type SupportedLanguage,
} from '@meebox/shared';
import enUS from './locales/en-US.json';

/**
 * Renderer internationalization (react-i18next).
 *
 * - Keys are **neutral identifiers** (like `chatPane.emptySelectPrTitle`); zh-CN / en-US / ja-JP /
 *   de-DE are **equivalent translation sets** (each locale fully covered, no source/translation hierarchy), organized by "component namespace"
 *   (a top-level object corresponds to a component, common holds cross-component reusable text).
 * - The actual language is decided by config.language via `resolveLanguage` (empty falls back to English per OS preference);
 *   after App startup gets boot.config it calls `i18n.changeLanguage` to switch.
 *
 * The default / fallback language is **en-US** (i18n project standard: English is most universal):
 * - en-US is **statically bundled** into the entry, and also serves as `fallbackLng` — any locale missing a key falls back to English rather than Chinese.
 * - zh-CN / ja-JP / de-DE are **lazy-loaded on demand** via resourcesToBackend + dynamic import: Vite splits each
 *   locale into a separate chunk, pulled only when switching to that language, not entering the entry bundle (the more languages, the greater the benefit).
 * - `partialBundledLanguages` lets static resources coexist with backend lazy loading; `useSuspense: false`
 *   makes switching a lazy-loaded language avoid Suspense — it auto re-renders once loaded, falling back to the current language meanwhile, no Suspense boundary needed.
 */

export { SUPPORTED_LANGUAGES, matchSupportedLanguage, type SupportedLanguage };

// Renderer synchronously cached "last language": config.language arrives asynchronously via IPC and is unavailable at startup;
// localStorage can be read synchronously, so use it as the initial language, avoiding English/Japanese/German users flashing a frame of Chinese on startup.
// Once App gets config.language it persistLanguage-writes it back, for the next startup to hit directly.
const LANG_STORAGE_KEY = 'meebox.language';

/** Browser/OS preferred language list (the OS-detection source when config is empty). */
function osLocales(): string[] {
  try {
    return [...(navigator.languages ?? [navigator.language])].filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve the effective UI language: config.language takes priority, empty falls back to English per OS preference. */
export function resolveUiLanguage(configLang: string | null | undefined): SupportedLanguage {
  return resolveLanguage(configLang, osLocales());
}

function readInitialLanguage(): SupportedLanguage {
  try {
    // The last persisted language is already a resolved supported value, hit it directly; on first launch with no record, detect per OS preference.
    return matchSupportedLanguage(localStorage.getItem(LANG_STORAGE_KEY)) ?? resolveUiLanguage('');
  } catch {
    return resolveUiLanguage('');
  }
}

/** Persist the current language to localStorage, for the next startup to read synchronously as the initial language. */
export function persistLanguage(lang: string): void {
  try {
    const matched = matchSupportedLanguage(lang);
    if (matched) localStorage.setItem(LANG_STORAGE_KEY, matched);
  } catch {
    // Ignore when localStorage is unavailable: only affects the next startup's initial language hit, not functionality.
  }
}

/**
 * Make `<html lang>` follow the current UI language (initial + every switch). index.html statically hardcodes `zh-CN` and does not update on language switch,
 * which would mislead CSS `hyphens:auto` hyphenation (wrong-language hyphenation dictionary), screen readers, and font selection. i18n's languageChanged
 * covers all switch sources (startup / settings page / onboarding wizard / command palette), so syncing in this one place suffices.
 */
function syncDocumentLang(lng: string): void {
  try {
    document.documentElement.lang = lng;
  } catch {
    // Ignore when document is unavailable (non-standard host): only affects hyphenation / accessibility hints, not functionality.
  }
}

const initialLanguage = readInitialLanguage();
syncDocumentLang(initialLanguage);
i18n.on('languageChanged', syncDocumentLang);

void i18n
  .use(
    // zh-CN is already statically bundled, the backend only pulls the corresponding chunk on demand for the remaining languages.
    resourcesToBackend(
      (lng: string) =>
        import(`./locales/${lng}.json`) as Promise<{ default: Record<string, unknown> }>,
    ),
  )
  .use(initReactI18next)
  .init({
    resources: {
      // Only the default language en-US statically enters the entry; the rest are lazy-loaded by the backend.
      'en-US': { translation: enUS },
    },
    partialBundledLanguages: true,
    // Initial language takes the persisted value / OS preference (default falls back to English per OS): start directly in the user's language.
    lng: initialLanguage,
    // Fallback takes en-US (i18n standard: English is most universal): any locale missing a key falls back to English rather than Chinese.
    // Each locale is fully covered, single-layer fallback suffices; en-US is already statically bundled, so serving as fallback needs no extra chunk pull.
    fallbackLng: 'en-US',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // Note: **do not** enable nonExplicitSupportedLngs. It would normalize the region-coded 'zh-CN' to the base code 'zh'
    // for lookup, whereas the resource bundle is registered under 'zh-CN' → the namespace comes up empty, t() degrades to bare keys (whole page
    // untranslated). Before entering i18n the language is already normalized to an exact supported code by resolveLanguage/matchSupportedLanguage
    // (zh-CN/en-US/ja-JP/de-DE), so i18next need not do non-exact matching.
    load: 'currentOnly',
    interpolation: {
      // React already escapes interpolation, disable i18next's double-escaping to avoid things like &amp;.
      escapeValue: false,
    },
    returnNull: false,
    react: {
      // Do not throw Suspense when switching to a lazy-loaded language; auto re-render once loaded, falling back to the current language meanwhile.
      useSuspense: false,
    },
  });

export default i18n;
