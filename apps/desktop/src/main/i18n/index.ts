import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import { matchSupportedLanguage, type SupportedLanguage } from '@meebox/shared';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';
import jaJP from './locales/ja-JP.json';
import deDE from './locales/de-DE.json';

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

// 当前生效语言：由 initMainI18n 定档（传入的已是 resolveLanguage 解析后的有效值）。
// 供 pr-agent 响应语言（CONFIG__RESPONSE_LANGUAGE）等与 UI 保持一致地复用。
let currentLanguage: SupportedLanguage = 'zh-CN';

/** 主进程当前生效语言，供 pr-agent 响应语言等复用，保证与 UI 一致。 */
export function getMainLanguage(): SupportedLanguage {
  return currentLanguage;
}

/** 启动时调用一次：按已解析的有效语言（resolveLanguage 的结果）初始化主进程 i18n。 */
export function initMainI18n(language: string): void {
  currentLanguage = matchSupportedLanguage(language) ?? 'zh-CN';
  void instance.init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
      'ja-JP': { translation: jaJP },
      'de-DE': { translation: deDE },
    },
    lng: currentLanguage,
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
