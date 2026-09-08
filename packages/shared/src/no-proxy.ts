/**
 * Proxy bypass rules (`proxy.no_proxy`): which hosts egress **directly** even while the global proxy is on.
 *
 * Needed because the proxy is a single global egress: on a corporate network the proxy is the way out to the internet,
 * but the code platform, its git remote and a self-hosted model often live *inside* that network, where routing them
 * through the proxy at best wastes a hop and at worst makes them unreachable. Loopback is bypassed unconditionally;
 * everything else the user has to name, which is what these rules are.
 *
 * The syntax deliberately mirrors the conventional `NO_PROXY` environment variable, because that is exactly where these
 * rules end up for the subprocess egresses (git, pr-agent, local CLIs) — they are handed the variable and interpret it
 * with their own library. Keeping one syntax means the in-process matching here and those libraries agree; inventing a
 * richer one would make the two egress paths disagree for the same config, which is a class of bug nearly impossible to
 * diagnose from the UI. For the same reason the supported subset is kept to what is portable across implementations:
 *
 * - `*` on its own bypasses every host;
 * - a domain (`corp.example.com`) matches that host **and its subdomains**; a leading dot (`.corp.example.com`) is
 *   accepted and means the same thing, since implementations disagree on whether it also covers the bare domain and
 *   users expect it to;
 * - an IP literal matches exactly (IPv6 may be written with or without brackets);
 * - matching is case-insensitive, and a `:port` suffix on a rule is ignored (accepted so a value pasted from an
 *   existing `NO_PROXY` still works, but the port plays no part — bypass is decided per host).
 *
 * **CIDR ranges are not supported** (`10.0.0.0/8`): only some implementations honour them, so accepting one here would
 * bypass in-process while the subprocess egresses still proxied — the disagreement this file exists to avoid.
 */

/** Hosts that always bypass the proxy regardless of configuration, in `NO_PROXY` syntax. */
export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/** Strip an IPv6 literal's brackets and any `:port` suffix, and lowercase — the form both rules and hosts compare in. */
function normalizeHost(value: string): string {
  const v = value.trim().toLowerCase();
  if (!v) return '';
  // Bracketed IPv6, optionally with a port: [::1] / [::1]:8080
  const bracketed = /^\[(.+)\]/.exec(v);
  if (bracketed) return bracketed[1]!;
  // A bare IPv6 literal contains several colons, so a colon is only a port separator when there is exactly one.
  const colons = v.split(':').length - 1;
  if (colons === 1) return v.slice(0, v.indexOf(':'));
  return v;
}

/**
 * Split a raw `no_proxy` value into normalized rules. Accepts commas, whitespace and newlines as separators, so a value
 * pasted from an environment variable and one typed as a list both work; empty entries are dropped.
 */
export function parseNoProxy(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((r) => (r.trim() === '*' ? '*' : normalizeHost(r.replace(/^\./, ''))))
    .filter((r) => r.length > 0);
}

/** Normalize a raw `no_proxy` value for storage: one comma-separated line, deduplicated, in the order given. */
export function normalizeNoProxy(raw: string | undefined): string {
  return [...new Set(parseNoProxy(raw))].join(',');
}

/** Whether `host` is covered by the given `no_proxy` rules, i.e. it should egress directly. */
export function matchesNoProxy(host: string, raw: string | undefined): boolean {
  const target = normalizeHost(host);
  if (!target) return false;
  return parseNoProxy(raw).some(
    (rule) => rule === '*' || target === rule || target.endsWith(`.${rule}`),
  );
}
