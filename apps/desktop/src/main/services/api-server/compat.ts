import { lt as semverLt, valid as semverValid } from 'semver';

/**
 * CLI ↔ server 兼容性门控（见 docs/arch/04-integration/01-service-api.md）。
 *
 * CLI 每个请求带上自身版本头，服务端据集中管理的**最低可兼容版本**统一拦截过旧的 CLI——对所有 API 调用
 * 一视同仁，不做按端点的差异化兼容。默认宽松：缺版本头（旧 CLI / 非 CLI 客户端）或版本不可解析（如本地
 * `dev` 构建）均放行，保证既有 CLI 默认可用；仅当版本头**可解析且低于下限**时才门控。
 */

/** CLI 在此请求头声明自身版本（Node 会小写化头名）。与 CLI 端手写常量对齐（无代码级共享）。 */
export const CLI_VERSION_HEADER = 'x-meebox-cli-version';

/**
 * 服务端可兼容的最低 CLI 版本。破坏性线协议变更时上调此值，即门控掉更旧的 CLI。
 * 取当前 CLI 首发版本为下限（此前无更旧的已发布 CLI），默认不拦截任何在用版本。
 */
export const MIN_CLI_VERSION = '0.9.0';

/** 请求携带的 CLI 版本是否过旧（应拦截）。缺头 / 不可解析 → false（放行）。 */
export function isClientTooOld(rawHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!raw) return false;
  const v = semverValid(raw.trim());
  if (!v) return false; // 不可解析（dev 等）→ 放行
  return semverLt(v, MIN_CLI_VERSION);
}
