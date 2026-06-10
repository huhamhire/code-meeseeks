import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

/**
 * 渲染层国际化（react-i18next）。
 *
 * - 源语言（key 的书写语言）为简体中文 zh-CN；en-US 为待翻译目标。
 * - key 按「组件命名空间」组织：顶层 object 对应一个组件（chatPane / settings /
 *   statusBar …），common 放跨组件复用文案。
 * - 实际语言由 config.language 决定，App 启动拿到 boot.config 后调
 *   `i18n.changeLanguage(config.language)` 切换；这里先以 zh-CN 同步初始化，
 *   保证首帧渲染前 t() 即可用、不闪烁。
 */

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  // config.language 可能给出 'zh'/'zh-cn' 等大小写/缺地区变体，统一规整到受支持值。
  nonExplicitSupportedLngs: true,
  load: 'currentOnly',
  interpolation: {
    // React 已对插值做转义，关闭 i18next 二次转义避免 &amp; 之类。
    escapeValue: false,
  },
  returnNull: false,
});

/** 把 config.language（可能是 zh / zh-CN / en-US…）规整到受支持的语言代码。 */
export function normalizeLanguage(lang: string | undefined | null): SupportedLanguage {
  const norm = (lang ?? '').toLowerCase();
  if (norm.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

export default i18n;
