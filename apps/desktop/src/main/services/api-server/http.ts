import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, ERROR_CODES, type AppErrorMeta, type ErrorCode } from '@meebox/shared';

/**
 * HTTP utilities for the local API: unified response envelope ({ ok, data } / { ok:false, error }),
 * request body reading, error → HTTP status code mapping. See docs/arch/04-integration/01-service-api.md.
 */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB request body limit

/** API-layer error (auth / route / validation / write-forbidden, etc.): carries its own HTTP status code and error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly meta?: AppErrorMeta,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** Success response: 200 + { ok:true, data }. */
export function sendOk(res: ServerResponse, data: unknown): void {
  writeJson(res, 200, { ok: true, data: data ?? null });
}

/** Failure response: map error to status code + { ok:false, error:{ code, meta } }; return the chosen status / code for logging. */
export function sendError(res: ServerResponse, err: unknown): { status: number; code: string } {
  const mapped = mapError(err);
  writeJson(res, mapped.status, {
    ok: false,
    error: { code: mapped.code, ...(mapped.meta ? { meta: mapped.meta } : {}) },
  });
  return { status: mapped.status, code: mapped.code };
}

function mapError(err: unknown): { status: number; code: ErrorCode; meta?: AppErrorMeta } {
  if (err instanceof HttpError) return { status: err.status, code: err.code, meta: err.meta };
  if (err instanceof AppError) return { status: statusForAppCode(err.code), code: err.code, meta: err.meta };
  return { status: 500, code: ERROR_CODES.SV_UNCLASSIFIED };
}

/** Map the AppError business code thrown by controllers to a suitable HTTP status code (uncovered ones fall back to 500). */
function statusForAppCode(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.PR_NOT_FOUND:
      return 404;
    case ERROR_CODES.PR_FORBIDDEN:
      return 403;
    case ERROR_CODES.PR_URL_INVALID:
    case ERROR_CODES.AG_ASK_NEEDS_QUESTION:
      return 400;
    case ERROR_CODES.PR_NO_ACTIVE_CONNECTION:
      return 409;
    case ERROR_CODES.AG_PR_AGENT_NOT_READY:
      return 503;
    default:
      return 500;
  }
}

/** Read and parse the JSON request body (empty body → undefined); over-limit 413, invalid JSON 400, both normalized to SV error codes. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, ERROR_CODES.SV_BAD_REQUEST, { reason: 'body too large' });
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'invalid json' });
  }
}
