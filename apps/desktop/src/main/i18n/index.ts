import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

/**
 * 主进程国际化（独立的 i18next 实例，纯 Node，无 React）。
 *
 * - 与渲染层各持一份资源：main 的面向用户文本（dialog 标题、抛给渲染层并最终在
 *   toast/界面展示的错误消息）走这里。
 * - 语言在启动时由 `bootstrap.config.language` 一次性定下（`initMainI18n`）。
 *   main 进程的文案不随设置实时切换——改语言后重启生效，符合主进程文案的性质。
 * - key 命名沿用「区域命名空间」：dialog / prAgent / drafts / proxy / update。
 */

const instance: I18n = createInstance();

export type SupportedLanguage = 'zh-CN' | 'en-US';

/** 把 config.language（可能是 zh / zh-CN / en-US…）规整到受支持的语言代码。 */
function normalizeLanguage(lang: string | undefined | null): SupportedLanguage {
  return (lang ?? '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

/** 启动时调用一次：按 config.language 初始化主进程 i18n。 */
export function initMainI18n(language: string | undefined | null): void {
  void instance.init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
    lng: normalizeLanguage(language),
    fallbackLng: 'zh-CN',
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

/** 主进程翻译函数。未 init 时退化为返回 key（不抛错，保证健壮）。 */
export const t: TFunction = ((key: string, options?: Record<string, unknown>) =>
  instance.isInitialized ? instance.t(key, options) : key) as TFunction;

export default instance;
