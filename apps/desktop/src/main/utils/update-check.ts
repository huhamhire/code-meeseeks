// 版本更新检测（仅检测 + 提示，不下载 / 安装）。查 GitHub Releases 最新**稳定版**
// （/releases/latest 天然排除 prerelease/alpha），与当前版本做 semver 比对。
// 走配置的出站代理（企业内网友好）；匿名 GitHub API（低频，启动 + 手动），无需 token。

import type { ProxyConfig, UpdateCheckResult } from '@meebox/shared';
import { gt as semverGt, valid as semverValid } from 'semver';
import { proxyFetchForHost } from './proxy.js';
import { t } from '../i18n/index.js';

const OWNER = 'huhamhire';
const REPO = 'code-meeseeks';
const API_HOST = 'api.github.com';
const LATEST_URL = `https://${API_HOST}/repos/${OWNER}/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
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

  // semver.valid 容忍前缀 v、拒绝尾部垃圾（1.2.3beta / 1.2.3.4 → null）
  const current = semverValid(currentVersion);
  if (!current) return fail(t('update.parseCurrentFailed', { version: currentVersion }));

  // 代理感知 fetch（命中本地/代理关闭则用全局 fetch 直连）
  const doFetch = proxyFetchForHost(proxy, API_HOST) ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(LATEST_URL, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub API 要求 UA；用内部代号（OWNER/REPO 是真实仓库路径，属对外内容，保留）
        'User-Agent': 'meebox-updater',
      },
    });
    if (!res.ok) return fail(`GitHub API ${String(res.status)}`);
    const data = (await res.json()) as GithubRelease;
    // 只提示正式版：/releases/latest 本就排除 prerelease/draft；此处再防御一道，
    // 万一拿到 prerelease/draft 一律视为「无更新」，不引导用户升到预发布。
    if (data.prerelease || data.draft) {
      return { ok: true, hasUpdate: false, currentVersion };
    }
    const tag = data.tag_name;
    if (!tag) return fail(t('update.missingTag'));
    const latest = semverValid(tag);
    if (!latest) return fail(t('update.parseLatestFailed', { tag }));
    return {
      ok: true,
      hasUpdate: semverGt(latest, current),
      currentVersion,
      latestVersion: latest,
      url: data.html_url,
      publishedAt: data.published_at,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
