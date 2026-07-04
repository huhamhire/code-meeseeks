/**
 * Error codes and the unified error object. User-facing, cross-IPC backend errors all throw AppError, carried by an error code, with localization done by the frontend per code.
 * Design see docs/arch/99-core/04-error-codes.md. Technical exceptions / background logs still use English (boundary: whether shown to the user across IPC).
 */

/** Domain tag (two uppercase letters). New domains are appended at the end. */
export type ErrorDomain = 'AG' | 'UI' | 'CF' | 'NT' | 'PR' | 'SV';

/**
 * Error code registry (single source of truth): `E` + two-letter domain + four digits. New codes are registered here, and `errors.<CODE>` is added
 * to each locale in the renderer. Each domain reserves `0000` as the unclassified fallback.
 */
export const ERROR_CODES = {
  /** Unclassified Agent error (fallback). */
  AG_UNCLASSIFIED: 'EAG0000',
  /** `/ask` is missing question. */
  AG_ASK_NEEDS_QUESTION: 'EAG0001',
  /** A `/{tool}` task for this PR is already running or queued (meta.tool). */
  AG_DUPLICATE_TASK: 'EAG0002',
  /** pr-agent is not ready (neither the embedded runtime nor a local CLI was detected). */
  AG_PR_AGENT_NOT_READY: 'EAG0003',
  /** Unclassified config error (fallback). */
  CF_UNCLASSIFIED: 'ECF0000',
  /** Platform version below the supported minimum (meta.version actual version, meta.min minimum requirement). */
  CF_UNSUPPORTED_VERSION: 'ECF0001',
  /** Unclassified network error (fallback). */
  NT_UNCLASSIFIED: 'ENT0000',
  /** Proxy not enabled or host is empty. */
  NT_PROXY_DISABLED: 'ENT0001',
  /** Proxy authentication failed (407). */
  NT_PROXY_AUTH_FAILED: 'ENT0407',
  /** Unclassified PR / draft error (fallback). */
  PR_UNCLASSIFIED: 'EPR0000',
  /** Draft does not exist (may have been deleted). */
  PR_DRAFT_NOT_FOUND: 'EPR0001',
  /** Draft has been rejected, skipped. */
  PR_DRAFT_REJECTED: 'EPR0002',
  /** PR has already been merged (local state lags, the remote was already merged at merge time). */
  PR_ALREADY_MERGED: 'EPR0003',
  /** The provided link is not a PR / MR link for the current platform (cannot be parsed). */
  PR_URL_INVALID: 'EPR0004',
  /** The PR cannot be found on the remote (does not exist, or is not visible to you due to lack of permission). */
  PR_NOT_FOUND: 'EPR0005',
  /** No permission to access this PR / repository (403). */
  PR_FORBIDDEN: 'EPR0006',
  /** No active connection, cannot open a PR by link. */
  PR_NO_ACTIVE_CONNECTION: 'EPR0007',
  /**
   * Local API service (service listener) domain error codes. **Returned to the external CLI / client over HTTP**, not through renderer i18n
   * (so not registered in the renderer locale for now; if displayed in the GUI in the future, add `errors.<CODE>`, formatBackendError already has a fallback).
   * See docs/arch/04-integration/01-service-api.md.
   */
  /** Unclassified service error (fallback). */
  SV_UNCLASSIFIED: 'ESV0000',
  /** Authentication failed: missing / mismatched bearer token (→ HTTP 401). */
  SV_UNAUTHORIZED: 'ESV0001',
  /** The write operation is not exposed through the local API (→ HTTP 403). */
  SV_WRITE_NOT_ALLOWED: 'ESV0002',
  /** Route / resource does not exist (→ HTTP 404). */
  SV_NOT_FOUND: 'ESV0003',
  /** Request body validation failed (→ HTTP 400). */
  SV_BAD_REQUEST: 'ESV0004',
  /** CLI version below the server's compatible minimum (→ HTTP 426; meta.minVersion minimum requirement, meta.clientVersion actual version). */
  SV_CLIENT_TOO_OLD: 'ESV0005',
} as const;

/** Union of registered error code literals (only registered codes may be thrown, to prevent typos). */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** AppError.meta: only serializable scalars, for frontend i18n interpolation + diagnostics; do not put large objects / credentials in. */
export type AppErrorMeta = Record<string, string | number | boolean>;

const SENTINEL = '@meebox/err';
const CODE_RE = /^E[A-Z]{2}\d{4}$/;

/** Encode {code, meta} into the message: Electron IPC reliably preserves only Error.message, custom properties are lost. */
function encode(code: ErrorCode, meta: AppErrorMeta | undefined, msg: string): string {
  return `${SENTINEL} ${JSON.stringify({ code, msg, ...(meta ? { meta } : {}) })}`;
}

/**
 * Unified business error: user-facing, cross-IPC errors all throw it. `code` decides the semantics / frontend i18n; `meta` carries interpolation + diagnostics.
 * `message` is the encoded string (including the human-readable `msg` for logging); the frontend restores {code, meta} via decodeAppError.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly meta?: AppErrorMeta;

  constructor(code: ErrorCode, meta?: AppErrorMeta, msg?: string) {
    super(encode(code, meta, msg ?? code));
    this.name = 'AppError';
    this.code = code;
    this.meta = meta;
  }
}

/**
 * Get the wire encoding string of an error code (same shape as AppError.message). For "result envelope"-style errors: in the result object returned to the frontend,
 * replace the localized string field with this encoded string, and the frontend goes through the same decode + i18n path via decodeAppError / formatBackendError.
 */
export function errorCodeMessage(code: ErrorCode, meta?: AppErrorMeta): string {
  return encode(code, meta, code);
}

export interface DecodedAppError {
  /** Error code (format validated; may be an unregistered new code, handled by the frontend's i18n fallback). */
  code: string;
  meta?: AppErrorMeta;
}

/**
 * Decode the AppError envelope from an error message (which may have an `Error invoking remote method …:` prefix added by Electron).
 * Not this envelope / parse failure → null (the caller falls back).
 */
export function decodeAppError(message: string): DecodedAppError | null {
  const at = message.indexOf(SENTINEL);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(at + SENTINEL.length).trim()) as {
      code?: unknown;
      meta?: unknown;
    };
    if (typeof parsed.code === 'string' && CODE_RE.test(parsed.code)) {
      const meta = parsed.meta;
      return {
        code: parsed.code,
        meta: meta && typeof meta === 'object' ? (meta as AppErrorMeta) : undefined,
      };
    }
  } catch {
    /* not this envelope */
  }
  return null;
}

/** Get the domain tag of an error code. */
export function errorDomain(code: string): ErrorDomain {
  return code.slice(1, 3) as ErrorDomain;
}
