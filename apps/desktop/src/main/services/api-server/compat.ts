import { coerce as semverCoerce, lt as semverLt, valid as semverValid } from 'semver';

/**
 * CLI ↔ server compatibility gating (see docs/arch/04-integration/01-service-api.md).
 *
 * The CLI carries its own version header on every request, and the server uniformly blocks too-old CLIs per a centrally managed **minimum compatible version** — treating all API calls
 * alike, without per-endpoint differentiated compatibility. Lenient by default: a missing version header (old CLI / non-CLI client) or an unparseable version (e.g. local
 * `dev` builds) is let through, ensuring existing CLIs work by default; gating applies only when the version header is **parseable and below the lower bound**.
 *
 * **Compare by version line (major.minor.patch), ignoring the prerelease suffix**: the CLI and app ship from the same source, and a prerelease build (e.g.
 * `0.9.0-alpha.1`) belongs to the same version line as its release and shares the same line protocol. In semver a prerelease is **lower than** its release
 * (`0.9.0-alpha.1` < `0.9.0`), so a direct comparison would misjudge a prerelease CLI on the same line as the lower bound as too old (with lower bound `0.9.0`, even
 * `0.9.0-alpha.1` is blocked). So coerce the version to `major.minor.patch` before comparing — the lower bound is a version-line-grained
 * breaking-change gate, not distinguishing prerelease ordinals within the same line.
 */

/** The CLI declares its own version in this request header (Node lowercases header names). Aligned with the CLI-side hand-written constant (no code-level sharing). */
export const CLI_VERSION_HEADER = 'x-meebox-cli-version';

/**
 * The minimum CLI version the server is compatible with. Raise this on a breaking line protocol change to gate out older CLIs.
 * Set to the current CLI's first-release version as the lower bound (no older published CLI exists before it), blocking no in-use version by default.
 */
export const MIN_CLI_VERSION = '0.9.0';

/** Whether the request's carried CLI version is too old (should be blocked). Missing header / unparseable → false (let through). */
export function isClientTooOld(rawHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!raw) return false;
  const v = semverValid(raw.trim());
  if (!v) return false; // unparseable (dev etc.) → let through
  // Strip the prerelease suffix and compare by version line (major.minor.patch), so a same-line prerelease is not below the lower bound (see file-header comment).
  const line = semverCoerce(v);
  if (!line) return false;
  return semverLt(line, MIN_CLI_VERSION);
}
