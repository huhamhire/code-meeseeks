// Make @monaco-editor/react use the local monaco-editor package instead of pulling loader.js from a CDN.
// Pairs with the strict CSP (no cdn.jsdelivr.net exception).
//
// Only register the base editor worker; markdown / generic diff don't need the JSON/CSS/HTML/TS language workers.
// When M1+ actually needs syntax highlighting, import the corresponding language worker on demand.

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
// The 4 contribution submodules for "worker-backed language services" (editor.main already loaded them; importing
// again here is only to grab their named-exported *Defaults; ES module singletons won't re-execute). Their runtime
// JS named-exports typescriptDefaults / jsonDefaults / cssDefaults … but the .d.ts is wrongly `export {}` (monaco
// 0.55 ESM bundling defect), so import as namespace and cast via unknown below into the known shapes, without any.
import * as tsLang from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import * as jsonLang from 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import * as cssLang from 'monaco-editor/esm/vs/language/css/monaco.contribution.js';
import * as htmlLang from 'monaco-editor/esm/vs/language/html/monaco.contribution.js';
// Third-party editor themes (IStandaloneThemeData shape, vendored from monaco-themes, see editor-themes/NOTICE.md),
// registered via defineTheme below for selection. ids align with @meebox/shared EDITOR_THEME_OPTIONS; vs / vs-dark /
// hc-* are Monaco built-ins, no registration needed. Vendored in place rather than an npm dependency: monaco-themes'
// exports don't expose the ./themes/* subpath.
import githubLight from './editor-themes/github-light.json';
import githubDark from './editor-themes/github-dark.json';
import monokai from './editor-themes/monokai.json';
import dracula from './editor-themes/dracula.json';
import nord from './editor-themes/nord.json';
import nightOwl from './editor-themes/night-owl.json';
import tomorrow from './editor-themes/tomorrow.json';
import tomorrowNight from './editor-themes/tomorrow-night.json';
import solarizedLight from './editor-themes/solarized-light.json';
import solarizedDark from './editor-themes/solarized-dark.json';
import cobalt2 from './editor-themes/cobalt2.json';
import oceanicNext from './editor-themes/oceanic-next.json';
// VS Code built-in 2026 default themes (converted from microsoft/vscode theme-defaults, include chain resolved and converted to Monaco shape).
import dark2026 from './editor-themes/dark-2026.json';
import light2026 from './editor-themes/light-2026.json';

// Vite's ?worker import returns a newable Worker constructor class.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

// Register third-party editor themes (id → theme data). Monaco built-in vs / vs-dark / hc-* aren't in this list.
// The JSON's base field is typed string, not fully compatible with IStandaloneThemeData's literal union, so cast via unknown.
const CUSTOM_EDITOR_THEMES: ReadonlyArray<readonly [string, unknown]> = [
  ['github-light', githubLight],
  ['github-dark', githubDark],
  ['monokai', monokai],
  ['dracula', dracula],
  ['nord', nord],
  ['night-owl', nightOwl],
  ['tomorrow', tomorrow],
  ['tomorrow-night', tomorrowNight],
  ['solarized-light', solarizedLight],
  ['solarized-dark', solarizedDark],
  ['cobalt2', cobalt2],
  ['oceanic-next', oceanicNext],
  ['dark-2026', dark2026],
  ['light-2026', light2026],
];
for (const [id, data] of CUSTOM_EDITOR_THEMES) {
  monaco.editor.defineTheme(id, data as unknown as monaco.editor.IStandaloneThemeData);
}

/**
 * [SPIKE] Get a theme's base + colors by id, for the "GUI chrome follows editor theme" experiment to extract base
 * colors like background / foreground / selection. Third-party monaco-themes carry only a handful of colors (a few
 * editor.* keys); built-in vs / vs-dark / hc-* have no JSON, so supply minimal known colors here. Removable
 * wholesale if not adopted after the experiment.
 */
export interface EditorThemeColorData {
  base: string;
  colors: Record<string, string>;
}
const BUILTIN_THEME_COLORS: Record<string, EditorThemeColorData> = {
  vs: {
    base: 'vs',
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#000000',
      'editor.selectionBackground': '#add6ff',
    },
  },
  'vs-dark': {
    base: 'vs-dark',
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editor.selectionBackground': '#264f78',
    },
  },
  'hc-black': {
    base: 'hc-black',
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#ffffff',
      'editor.selectionBackground': '#264f78',
    },
  },
  'hc-light': {
    base: 'hc-light',
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#292929',
      'editor.selectionBackground': '#add6ff',
    },
  },
};
const CUSTOM_THEME_COLORS: Record<string, EditorThemeColorData> = Object.fromEntries(
  CUSTOM_EDITOR_THEMES.map(([id, data]) => {
    const d = data as { base?: string; colors?: Record<string, string> };
    return [id, { base: d.base ?? 'vs-dark', colors: d.colors ?? {} }];
  }),
);
export function getEditorThemeColors(id: string): EditorThemeColorData | null {
  return CUSTOM_THEME_COLORS[id] ?? BUILTIN_THEME_COLORS[id] ?? null;
}

/**
 * Turn off all features of the 4 "worker-backed language service" language families: typescript/javascript
 * (ts.worker), json (json.worker), css/scss/less (css.worker), html/handlebars/razor (html.worker).
 *
 * This app only uses Monaco for read-only diff + syntax coloring (coloring goes through the monarch tokenizer,
 * unrelated to language services), and needs no completion / hover / symbols / diagnostics / formatting, etc.;
 * those features send RPCs to the corresponding *.worker (getNavigationTree / getSyntacticDiagnostics /
 * doValidation …). But we only registered the base editor.worker (see getWorker above) → these methods find no
 * handler and throw `Missing requestHandler or method: …`.
 *
 * Passing an empty ModeConfiguration (each field is optional, absent = don't register that provider) → these
 * providers are no longer registered, no longer send RPCs, eliminating the whole family of errors at the source
 * (the window fallback below degrades to pure insurance). The other 80+ languages are pure monarch tokenizer
 * coloring with no worker backend, unaffected and needing no handling.
 */
interface LangServiceDefaults {
  // Passing an empty ModeConfiguration (each field is optional, absent = don't register that provider) = turn off all features
  setModeConfiguration(modeConfiguration: object): void;
}
// The runtime named exports exist (see each contribution.js's export), but their .d.ts is wrongly `export {}`, so
// cast via unknown into the known *Defaults shape (without any); filter as fallback when a name is missing, so a future monaco rename won't crash.
const defaultsOf = (mod: unknown, names: readonly string[]): LangServiceDefaults[] =>
  names
    .map((n) => (mod as Record<string, LangServiceDefaults | undefined>)[n])
    .filter((d): d is LangServiceDefaults => typeof d?.setModeConfiguration === 'function');

for (const d of [
  ...defaultsOf(tsLang, ['typescriptDefaults', 'javascriptDefaults']),
  ...defaultsOf(jsonLang, ['jsonDefaults']),
  ...defaultsOf(cssLang, ['cssDefaults', 'scssDefaults', 'lessDefaults']),
  ...defaultsOf(htmlLang, ['htmlDefaults', 'handlebarDefaults', 'razorDefaults']),
]) {
  d.setModeConfiguration({});
}

/**
 * When Monaco quickly switches files in DiffEditor, a race occurs where the model is already disposed but the
 * widget is still finishing up; plus a series of runtime errors from "the built-in ts/js language contribution
 * proactively asking for inlayHints / quickInfo / navigationTree / ..., which editor.worker doesn't implement".
 * Neither affects rendering, but they pollute the console and make users think the app crashed.
 *
 * Only swallow by a message-prefix blacklist, leaving other real business errors untouched.
 *
 * The whole `Missing requestHandler or method:` family stems from worker RPCs finding no handler (already turned
 * off at the source above by disabling the corresponding language services; kept here as double insurance);
 * `TextModel got disposed …` is the DiffEditor model-switch dispose race. Both are Monaco upstream known issues,
 * don't affect rendering, and can't be eradicated on the app side → **silently ignored by default** (as known
 * issues). To diagnose, run `localStorage.setItem('meebox.monacoDebug','1')` in devtools and refresh to see the
 * details of the swallowed errors.
 */
const MONACO_DEBUG = (() => {
  try {
    return localStorage.getItem('meebox.monacoDebug') === '1';
  } catch {
    return false;
  }
})();
const BENIGN_MONACO_ERROR_PREFIXES = ['Missing requestHandler or method:'];
const BENIGN_MONACO_ERROR_SUBSTRINGS = [
  'TextModel got disposed before DiffEditorWidget model got reset',
];

function isBenignMonacoError(msg: unknown): boolean {
  if (typeof msg !== 'string') return false;
  if (BENIGN_MONACO_ERROR_PREFIXES.some((p) => msg.includes(p))) return true;
  if (BENIGN_MONACO_ERROR_SUBSTRINGS.some((s) => msg.includes(s))) return true;
  return false;
}

window.addEventListener('error', (e) => {
  if (isBenignMonacoError(e.message) || isBenignMonacoError(e.error?.message)) {
    e.preventDefault();
    // Silent by default (known issue); only log a line when meebox.monacoDebug is on, for diagnostics
    if (MONACO_DEBUG) console.warn('[monaco] suppressed benign error:', e.message);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: unknown } | unknown;
  const msg = typeof reason === 'string' ? reason : (reason as { message?: unknown })?.message;
  if (isBenignMonacoError(msg)) {
    e.preventDefault();
    if (MONACO_DEBUG) console.warn('[monaco] suppressed benign rejection:', msg);
  }
});
