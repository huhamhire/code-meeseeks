import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import {
  SUPPORTED_LANGUAGES,
  matchSupportedLanguage,
  resolveLanguage,
  type SupportedLanguage,
} from '@meebox/shared';
import zhCN from './locales/zh-CN.json';

/**
 * 渲染层国际化（react-i18next）。
 *
 * - 源语言（key 的书写语言）为简体中文 zh-CN；en-US / ja-JP / de-DE 为译文。
 * - key 按「组件命名空间」组织：顶层 object 对应一个组件（chatPane / settings /
 *   statusBar …），common 放跨组件复用文案。
 * - 实际语言由 config.language 经 `resolveLanguage` 决定（空则按 OS 偏好回落英语）；
 *   App 启动拿到 boot.config 后调 `i18n.changeLanguage` 切换。
 *
 * 资源加载策略（**默认静态 + 其余懒加载**）：
 * - 默认 zh-CN **静态打包**进入口（同时作 fallbackLng），保证首帧 t() 即可用、不闪。
 * - en-US / ja-JP / de-DE 经 resourcesToBackend + 动态 import **按需懒加载**：Vite 把
 *   每份 locale 拆成独立 chunk，仅当切到该语言时才拉取，不进入口包（语言越多收益越大）。
 * - `partialBundledLanguages` 让静态 resources 与 backend 懒加载共存；`useSuspense: false`
 *   使切换懒加载语言时不走 Suspense——加载完成自动重渲，期间回退当前语言，无需 Suspense 边界。
 */

export { SUPPORTED_LANGUAGES, matchSupportedLanguage, type SupportedLanguage };

// 渲染层同步缓存的「上次语言」：config.language 经 IPC 异步到达，启动时拿不到；
// localStorage 可同步读，故用它做初始语言，避免英语/日语/德语用户启动先闪一帧中文。
// App 拿到 config.language 后会 persistLanguage 回写，供下次启动直接命中。
const LANG_STORAGE_KEY = 'meebox.language';

/** 浏览器/OS 偏好语言列表（作 config 为空时的 OS 探测来源）。 */
function osLocales(): string[] {
  try {
    return [...(navigator.languages ?? [navigator.language])].filter(Boolean);
  } catch {
    return [];
  }
}

/** 解析有效 UI 语言：config.language 优先，空则按 OS 偏好回落英语。 */
export function resolveUiLanguage(configLang: string | null | undefined): SupportedLanguage {
  return resolveLanguage(configLang, osLocales());
}

function readInitialLanguage(): SupportedLanguage {
  try {
    // 上次持久化的语言已是解析后的受支持值，直接命中；首启无记录时按 OS 偏好探测。
    return matchSupportedLanguage(localStorage.getItem(LANG_STORAGE_KEY)) ?? resolveUiLanguage('');
  } catch {
    return resolveUiLanguage('');
  }
}

/** 持久化当前语言到 localStorage，供下次启动同步读取作初始语言。 */
export function persistLanguage(lang: string): void {
  try {
    const matched = matchSupportedLanguage(lang);
    if (matched) localStorage.setItem(LANG_STORAGE_KEY, matched);
  } catch {
    // localStorage 不可用时忽略：仅影响下次启动的初始语言命中，不影响功能。
  }
}

void i18n
  .use(
    // zh-CN 已静态打包，backend 只为其余语言按需拉取对应 chunk。
    resourcesToBackend(
      (lng: string) =>
        import(`./locales/${lng}.json`) as Promise<{ default: Record<string, unknown> }>,
    ),
  )
  .use(initReactI18next)
  .init({
    resources: {
      // 仅默认语言静态进入口；其余由 backend 懒加载。
      'zh-CN': { translation: zhCN },
    },
    partialBundledLanguages: true,
    // 初始语言取持久化值 / OS 偏好（默认不写死中文）：直接以用户语言启动。
    lng: readInitialLanguage(),
    // 兜底永远是源语言 zh-CN（静态打包、最完整）：任何译文缺 key 回退到它。
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    nonExplicitSupportedLngs: true,
    load: 'currentOnly',
    interpolation: {
      // React 已对插值做转义，关闭 i18next 二次转义避免 &amp; 之类。
      escapeValue: false,
    },
    returnNull: false,
    react: {
      // 切到懒加载语言时不抛 Suspense；加载完成后自动重渲，期间回退当前语言。
      useSuspense: false,
    },
  });

export default i18n;
