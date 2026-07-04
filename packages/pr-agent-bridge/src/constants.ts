import type { ReviewRunTool } from '@meebox/shared';

/**
 * Single collection point for constants shared within the package: subprocess timeout fallbacks, the force-UTF-8 spawn env, pr-agent local provider output file names.
 * Same-kind constants scattered elsewhere are consolidated here for uniform reuse and tuning.
 */

// /review on a long PR + reasoning model (DeepSeek-v4 / Claude thinking) often runs 3-8 min; 5 min frequently hits timeout.
// Set to 10 min so the vast majority of real PRs finish, while still catching a stuck subprocess so it doesn't hang forever. If more is needed the caller can
// override explicitly via opts.timeoutMs.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// chat channel per-call default 5 min: orchestration / judgment calls are usually far faster than /review, but reasoning models can still be slow.
export const DEFAULT_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
// Runtime detect (spawn `--version` scale) default 5s timeout fallback: enough and doesn't slow startup.
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Force-UTF-8 spawn env: on Chinese Windows the embedded Python defaults to the system code page (GBK/cp936) for stdio / file
 * encoding, so when pr-agent output contains emoji (e.g. the 🔍 section title) it crashes with 'gbk' codec can't encode. PYTHONUTF8=1
 * overrides stdio + fs + default open() encoding, with PYTHONIOENCODING as fallback. Applied uniformly to every spawned python subprocess.
 */
export const UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } as const;

/**
 * The on-disk output file name for each pr-agent local provider tool (path relative to the worktree root):
 *   /describe → description.md (publish_description)
 *   /review   → review.md      (publish_comment)
 *   /ask      → review.md      (shares the same file, publish_comment overwrites)
 *   /improve  → improve.md     (aggregated suggestions go through publish_comment, split from review.md via LOCAL__REVIEW_PATH redirect)
 * Used both by buildToolEnv to set LOCAL__REVIEW_PATH and by the caller to read the output file after run finishes — both sides share this table to stay in sync.
 */
export const PRAGENT_LOCAL_OUTPUT: Record<ReviewRunTool, string> = {
  describe: 'description.md',
  review: 'review.md',
  ask: 'review.md',
  improve: 'improve.md',
};
