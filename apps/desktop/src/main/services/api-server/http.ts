import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, ERROR_CODES, type AppErrorMeta, type ErrorCode } from '@meebox/shared';

/**
 * 本地 API 的 HTTP 工具：统一响应封套（{ ok, data } / { ok:false, error }）、请求体读取、
 * 错误 → HTTP 状态码映射。见 docs/arch/04-integration/01-service-api.md。
 */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB 请求体上限

/** API 层错误（鉴权 / 路由 / 校验 / 写禁止等）：自带 HTTP 状态码与错误码。 */
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

/** 成功响应：200 + { ok:true, data }。 */
export function sendOk(res: ServerResponse, data: unknown): void {
  writeJson(res, 200, { ok: true, data: data ?? null });
}

/** 失败响应：按错误映射状态码 + { ok:false, error:{ code, meta } }；返回所选状态码 / 码供日志。 */
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

/** 把控制器抛出的 AppError 业务码映射到合适的 HTTP 状态码（未覆盖者归 500）。 */
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

/** 读取并解析 JSON 请求体（空体 → undefined）；超限 413、非法 JSON 400，均归一为 SV 错误码。 */
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
