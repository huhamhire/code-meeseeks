// Version update check (check + notify only, no download / install). Queries the latest **stable release**
// from GitHub Releases (/releases/latest naturally excludes prerelease/alpha) and does a semver comparison against the current version.
// Goes through the configured outbound proxy (enterprise-intranet friendly); anonymous GitHub API (low frequency, startup + manual), no token needed.

import type { ProxyConfig, UpdateCheckResult } from '@meebox/shared';
import { gt as semverGt, valid as semverValid } from 'semver';
import { proxyFetchForHost } from './proxy.js';

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
 * Check whether a new version exists. Any network / parse failure collapses into ok=false + error, never throws.
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

  // semver.valid tolerates a leading v, rejects trailing garbage (1.2.3beta / 1.2.3.4 → null)
  const current = semverValid(currentVersion);
  if (!current) return fail(`Unable to parse the current version: ${currentVersion}`);

  // proxy-aware fetch (hits local / proxy disabled → uses global fetch for a direct connection)
  const doFetch = proxyFetchForHost(proxy, API_HOST) ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(LATEST_URL, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub API requires a UA; use the internal codename (OWNER/REPO are the real repo path, outward-facing content, kept)
        'User-Agent': 'meebox-updater',
      },
    });
    if (!res.ok) return fail(`GitHub API ${String(res.status)}`);
    const data = (await res.json()) as GithubRelease;
    // Only notify for stable releases: /releases/latest already excludes prerelease/draft; defend once more here,
    // in case a prerelease/draft comes through treat it uniformly as "no update", never steering the user to a prerelease.
    if (data.prerelease || data.draft) {
      return { ok: true, hasUpdate: false, currentVersion };
    }
    const tag = data.tag_name;
    if (!tag) return fail('Release is missing tag_name');
    const latest = semverValid(tag);
    if (!latest) return fail(`Unable to parse the latest version: ${tag}`);
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
