// 版本更新检测（仅检测 + 提示，不下载 / 安装）。查 GitHub Releases 最新**稳定版**
// （/releases/latest 天然排除 prerelease/alpha），与当前版本做 semver 比对。
// 走配置的出站代理（企业内网友好）；匿名 GitHub API（低频，启动 + 手动），无需 token。

import type { ProxyConfig, UpdateCheckResult } from '@meebox/shared';
import { proxyFetchForHost } from './proxy.js';

const OWNER = 'huhamhire';
const REPO = 'code-meeseeks';
const API_HOST = 'api.github.com';
const LATEST_URL = `https://${API_HOST}/repos/${OWNER}/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;

interface ParsedVersion {
  core: [number, number, number];
  /** 预发布标识（`-` 之后），稳定版为空数组 */
  pre: string[];
}

/** 解析 `v1.2.3` / `1.2.3-alpha.2` → 结构；解析不出返回 null。 */
function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** semver 比较：返回 a-b 的符号（1 / 0 / -1）。预发布优先级低于同核心的正式版。 */
function compareVersion(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]! ? 1 : -1;
  }
  // 核心相同：有 pre < 无 pre
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  // 都有 pre：逐段比较（数字段按数值，否则按字典序）
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
}

/**
 * 检测是否有新版本。任何网络 / 解析失败都收敛成 ok=false + error，不抛。
 */
export async function checkForUpdate(
  currentVersion: string,
  proxy: ProxyConfig,
): Promise<UpdateCheckResult> {
  const fail = (error: string): UpdateCheckResult => ({
    ok: false,
    hasUpdate: false,
    currentVersion,
    error,
  });

  const current = parseVersion(currentVersion);
  if (!current) return fail(`无法解析当前版本号：${currentVersion}`);

  // 代理感知 fetch（命中本地/代理关闭则用全局 fetch 直连）
  const doFetch = proxyFetchForHost(proxy, API_HOST) ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(LATEST_URL, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub API 要求 UA；用产品标识
        'User-Agent': `${REPO}-updater`,
      },
    });
    if (!res.ok) return fail(`GitHub API ${String(res.status)}`);
    const data = (await res.json()) as GithubRelease;
    const tag = data.tag_name;
    if (!tag) return fail('Release 缺少 tag_name');
    const latest = parseVersion(tag);
    if (!latest) return fail(`无法解析最新版本号：${tag}`);
    const hasUpdate = compareVersion(latest, current) > 0;
    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion: tag.replace(/^v/, ''),
      url: data.html_url,
      publishedAt: data.published_at,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
