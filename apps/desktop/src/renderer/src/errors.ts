import { decodeAppError, errorDomain } from '@meebox/shared';
import i18n from './i18n';

/**
 * Translate raw exceptions thrown by the main process / adapters / fetch into text the user can understand.
 *
 * Design principles:
 * - **Do not hide the raw message**, the detail field keeps the original text for diagnosis
 * - Only recognize common patterns to give a title label; unmatched ones fall to the "unknown error" label
 * - Do not console.error here, the caller decides whether to log
 */
export interface FormattedError {
  /** Short label, colored text at the top of the UI or text next to an icon, e.g. "Connection timed out" */
  title: string;
  /** Detail, human-readable text for the user or the raw message */
  detail: string;
  /** Classification for observability / auto-retry logic */
  kind: 'timeout' | 'network' | 'auth' | 'not-found' | 'platform' | 'unknown';
}

// title/hint store i18n keys, the actual text is translated in formatBackendError via i18n.t() (a pure module cannot use hooks)
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
  // First decode the unified error code (AppError envelope) → precise i18n by code (errors.<CODE>, meta as interpolation). Unregistered code / missing key →
  // generic fallback text + show the raw code (eases reporting). Not this envelope → fall to the regex pattern matching below (fallback for third-party / historical uncoded errors).
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
