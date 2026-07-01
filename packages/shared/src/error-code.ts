/**
 * 错误码与统一错误对象。面向用户、跨 IPC 的后端错误一律抛 AppError，以错误码承载，本地化由前端按码做。
 * 设计见 docs/arch/99-core/04-error-codes.md。技术异常 / 后台日志仍用英语（边界：是否跨 IPC 展示给用户）。
 */

/** 领域标签（两字母大写）。新增领域追加在末尾。 */
export type ErrorDomain = 'AG' | 'UI' | 'CF' | 'NT' | 'PR' | 'SV';

/**
 * 错误码注册表（唯一真相源）：`E` + 两字母领域 + 四位数字。新增码在此登记，并在渲染层各 locale 补
 * `errors.<CODE>`。每领域保留 `0000` 作未分类兜底。
 */
export const ERROR_CODES = {
  /** 未分类 Agent 错误（兜底）。 */
  AG_UNCLASSIFIED: 'EAG0000',
  /** `/ask` 缺少 question。 */
  AG_ASK_NEEDS_QUESTION: 'EAG0001',
  /** 该 PR 的 `/{tool}` 任务已在执行或排队中（meta.tool）。 */
  AG_DUPLICATE_TASK: 'EAG0002',
  /** pr-agent 未就绪（嵌入式运行时与本机 CLI 都未探测到）。 */
  AG_PR_AGENT_NOT_READY: 'EAG0003',
  /** 未分类配置错误（兜底）。 */
  CF_UNCLASSIFIED: 'ECF0000',
  /** 平台版本低于支持下限（meta.version 实际版本、meta.min 最低要求）。 */
  CF_UNSUPPORTED_VERSION: 'ECF0001',
  /** 未分类网络错误（兜底）。 */
  NT_UNCLASSIFIED: 'ENT0000',
  /** 代理未启用或地址为空。 */
  NT_PROXY_DISABLED: 'ENT0001',
  /** 代理认证失败（407）。 */
  NT_PROXY_AUTH_FAILED: 'ENT0407',
  /** 未分类 PR / 草稿错误（兜底）。 */
  PR_UNCLASSIFIED: 'EPR0000',
  /** 草稿不存在（可能已被删除）。 */
  PR_DRAFT_NOT_FOUND: 'EPR0001',
  /** 草稿已被拒绝、跳过。 */
  PR_DRAFT_REJECTED: 'EPR0002',
  /** PR 已被合并（本地状态滞后，合并时远端已是 merged）。 */
  PR_ALREADY_MERGED: 'EPR0003',
  /** 提供的链接不是当前平台的 PR / MR 链接（无法解析）。 */
  PR_URL_INVALID: 'EPR0004',
  /** 远端找不到该 PR（不存在，或无权限因而对你不可见）。 */
  PR_NOT_FOUND: 'EPR0005',
  /** 无权限访问该 PR / 仓库（403）。 */
  PR_FORBIDDEN: 'EPR0006',
  /** 没有活动连接，无法按链接打开 PR。 */
  PR_NO_ACTIVE_CONNECTION: 'EPR0007',
  /**
   * 本地 API 服务（service listener）域错误码。**经 HTTP 返回给外部 CLI / 客户端**，不经渲染层 i18n
   * （故暂不在 renderer locale 登记；如未来在 GUI 展示再补 `errors.<CODE>`，formatBackendError 已有兜底）。
   * 见 docs/arch/04-integration/01-service-api.md。
   */
  /** 未分类服务错误（兜底）。 */
  SV_UNCLASSIFIED: 'ESV0000',
  /** 鉴权失败：缺失 / 不匹配 bearer token（→ HTTP 401）。 */
  SV_UNAUTHORIZED: 'ESV0001',
  /** 写操作不经本地 API 开放（→ HTTP 403）。 */
  SV_WRITE_NOT_ALLOWED: 'ESV0002',
  /** 路由 / 资源不存在（→ HTTP 404）。 */
  SV_NOT_FOUND: 'ESV0003',
  /** 请求体校验失败（→ HTTP 400）。 */
  SV_BAD_REQUEST: 'ESV0004',
} as const;

/** 已登记的错误码字面量联合（抛错时只能用注册过的码，防笔误）。 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** AppError.meta：仅可序列化标量，供前端 i18n 插值 + 诊断；勿放大对象 / 凭据。 */
export type AppErrorMeta = Record<string, string | number | boolean>;

const SENTINEL = '@meebox/err';
const CODE_RE = /^E[A-Z]{2}\d{4}$/;

/** 把 {code, meta} 编码进 message：Electron IPC 仅可靠保留 Error.message，自定义属性会丢。 */
function encode(code: ErrorCode, meta: AppErrorMeta | undefined, msg: string): string {
  return `${SENTINEL} ${JSON.stringify({ code, msg, ...(meta ? { meta } : {}) })}`;
}

/**
 * 统一业务错误：面向用户、跨 IPC 的错误一律抛它。`code` 决定语义 / 前端 i18n；`meta` 携带插值 + 诊断。
 * `message` 为编码串（含人读 `msg` 便于日志）；前端经 decodeAppError 还原 {code, meta}。
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
 * 取错误码的 wire 编码串（与 AppError.message 同形）。供「结果信封」式错误使用：返回到前端的结果对象里
 * 把已本地化字符串字段换成此编码串，前端经 decodeAppError / formatBackendError 走同一条解码 + i18n 路径。
 */
export function errorCodeMessage(code: ErrorCode, meta?: AppErrorMeta): string {
  return encode(code, meta, code);
}

export interface DecodedAppError {
  /** 错误码（已校验格式；可能是未登记的新码，前端按 i18n 兜底处理）。 */
  code: string;
  meta?: AppErrorMeta;
}

/**
 * 从（可能被 Electron 加过 `Error invoking remote method …:` 前缀的）错误 message 中解码 AppError 信封。
 * 非本信封 / 解析失败 → null（调用方走兜底）。
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
    /* 非本信封 */
  }
  return null;
}

/** 取错误码的领域标签。 */
export function errorDomain(code: string): ErrorDomain {
  return code.slice(1, 3) as ErrorDomain;
}
