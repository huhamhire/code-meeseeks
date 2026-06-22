/**
 * 错误码与统一错误对象。面向用户、跨 IPC 的后端错误一律抛 AppError，以错误码承载，本地化由前端按码做。
 * 设计见 docs/arch/12-error-codes.md。技术异常 / 后台日志仍用英语（边界：是否跨 IPC 展示给用户）。
 */

/** 领域标签（两字母大写）。新增领域追加在末尾。 */
export type ErrorDomain = 'AG' | 'UI' | 'CF' | 'NT';

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
  /** 未分类网络错误（兜底）。 */
  NT_UNCLASSIFIED: 'ENT0000',
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
