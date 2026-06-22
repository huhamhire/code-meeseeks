import { decodeAppError, errorDomain } from '@meebox/shared';
import i18n from './i18n';

/**
 * 把 main 进程 / 适配器 / fetch 抛出的原始异常翻成用户能读懂的文案。
 *
 * 设计原则：
 * - **不把原始 message 隐藏掉**，detail 字段保留原文便于诊断
 * - 只识别常见模式给个 title 标签，未匹配的直接落到"未知错误"标签
 * - 不在这里 console.error，调用方决定是否记日志
 */
export interface FormattedError {
  /** 短标签，UI 顶部色字或图标旁文案，如"连接超时" */
  title: string;
  /** 详情，给用户看的人话或原始 message */
  detail: string;
  /** 给可观测性 / 自动重试逻辑用的归类 */
  kind: 'timeout' | 'network' | 'auth' | 'not-found' | 'platform' | 'unknown';
}

// title/hint 存 i18n key，实际文案在 formatBackendError 用 i18n.t() 翻译（纯模块无法用 hook）
const MATCHERS: Array<{
  re: RegExp;
  titleKey: string;
  kind: FormattedError['kind'];
  hintKey?: string;
}> = [
  {
    re: /Connect Timeout|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT/i,
    titleKey: 'errors.timeoutTitle',
    kind: 'timeout',
    hintKey: 'errors.timeoutHint',
  },
  {
    re: /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT/i,
    titleKey: 'errors.networkResetTitle',
    kind: 'network',
    hintKey: 'errors.networkResetHint',
  },
  {
    re: /ENOTFOUND|getaddrinfo|EAI_AGAIN/i,
    titleKey: 'errors.dnsTitle',
    kind: 'network',
    hintKey: 'errors.dnsHint',
  },
  {
    re: /ECONNREFUSED/i,
    titleKey: 'errors.refusedTitle',
    kind: 'network',
    hintKey: 'errors.refusedHint',
  },
  {
    re: /(?:^|\D)40[13]\b|Unauthorized|Forbidden/i,
    titleKey: 'errors.authTitle',
    kind: 'auth',
    hintKey: 'errors.authHint',
  },
  {
    re: /(?:^|\D)404\b|Not Found/i,
    titleKey: 'errors.notFoundTitle',
    kind: 'not-found',
    hintKey: 'errors.notFoundHint',
  },
  {
    re: /fetch failed/i,
    titleKey: 'errors.fetchFailedTitle',
    kind: 'platform',
  },
  {
    re: /Invalid symmetric difference expression/i,
    titleKey: 'errors.missingCommitRefTitle',
    kind: 'platform',
    hintKey: 'errors.missingCommitRefHint',
  },
  {
    re: /unknown revision or path not in the working tree/i,
    titleKey: 'errors.missingCommitTitle',
    kind: 'platform',
    hintKey: 'errors.missingCommitHint',
  },
  {
    re: /no such path .* in [0-9a-f]{7,}/i,
    titleKey: 'errors.pathMissingTitle',
    kind: 'not-found',
    hintKey: 'errors.pathMissingHint',
  },
];

export function formatBackendError(err: unknown): FormattedError {
  const raw = err instanceof Error ? err.message : String(err);
  // 先解码统一错误码（AppError 信封）→ 按码精确 i18n（errors.<CODE>，meta 作插值）。未注册码 / 缺 key →
  // 通用兜底文案 + 显示原始码（便于报障）。非本信封 → 落到下方正则模式匹配（第三方 / 历史未编码错误兜底）。
  const decoded = decodeAppError(raw);
  if (decoded) {
    const key = `errors.${decoded.code}`;
    const text = i18n.t(key, decoded.meta ?? {});
    const kind: FormattedError['kind'] = errorDomain(decoded.code) === 'NT' ? 'network' : 'unknown';
    if (text !== key) return { title: text, detail: text, kind };
    const fallback = i18n.t('errors.unknownCode', { code: decoded.code });
    return { title: fallback, detail: fallback, kind: 'unknown' };
  }
  for (const m of MATCHERS) {
    if (m.re.test(raw)) {
      return {
        title: i18n.t(m.titleKey),
        detail: m.hintKey ? `${i18n.t(m.hintKey)}\n\n${i18n.t('errors.rawPrefix')}${raw}` : raw,
        kind: m.kind,
      };
    }
  }
  return { title: i18n.t('errors.unknownTitle'), detail: raw, kind: 'unknown' };
}
