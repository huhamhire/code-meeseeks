/**
 * A single rule, loaded from a .md file under rules.dir.
 * frontmatter is yaml, body is the markdown content (ultimately injected as extra_instructions to pr-agent).
 *
 * Design principles:
 * - Every field has a lenient default (omitted = match anything / enabled / no labels). A rule file can write only
 *   the body without frontmatter, producing a globally-effective "base spec".
 * - applies_to.* values are **regex source strings**, converted to RegExp at load time, .test() against the field
 *   value at match time. Field omitted → match anything.
 * - A single pragent:run may have multiple rules matched; the caller sorts by priority desc + filePath asc and
 *   **takes only the first** (pickMatchingRule). The complex semantics of concatenating multiple rules are left for
 *   later on-demand extension.
 */
export type RuleTool = 'describe' | 'review' | 'improve';

/**
 * Cap on matched rules injected per review: beyond this, take the top N by sort order (priority desc + id asc) and
 * drop the rest, avoiding prompt bloat. A safety fallback, not hard-constraint semantics.
 */
export const DEFAULT_MAX_MATCHED_RULES = 20;

/**
 * Cap on .md files recursively collected from a single rules directory: stop and warn once reached, avoiding dragging
 * down loading when the rules dir is mistakenly pointed at a huge directory tree (performance fallback interception).
 * Set far above the match cap, leaving ample room for non-matched rules.
 */
export const MAX_RULE_FILES = 200;

export interface RuleApplies {
  /** Bitbucket projectKey regex, e.g. "^FX$" or "^FX-.*" */
  project?: RegExp;
  /** Bitbucket repoSlug regex, e.g. "^fx-.*" */
  repo?: RegExp;
  /** PR base branch display name regex, e.g. "^(master|main)$" */
  target_branch?: RegExp;
}

export interface Rule {
  /** File path relative to rules.dir (including .md), serving as id + UI display + sort tie-break */
  id: string;
  /** File absolute path, used when the caller needs to display / navigate to it */
  filePath: string;
  applies_to: RuleApplies;
  /** Defaults to `['review']`: rule semantics lean toward code review, injecting constraints into /describe easily derails the description */
  tools: ReadonlyArray<RuleTool>;
  /** custom_labels passed to pr-agent on match (not wired in for P0, just parsed and stored for now) */
  custom_labels: ReadonlyArray<string>;
  /** When multiple match simultaneously, sort by priority desc; default 0 */
  priority: number;
  /** Whether enabled; when false loadRules still reads it in but pickMatchingRule skips it */
  enabled: boolean;
  /** markdown body, injected as extra_instructions to pr-agent */
  instructions: string;
}

export interface RuleMatchContext {
  projectKey: string;
  repoSlug: string;
  /** PR base ref displayId (master / main / develop / ...) */
  targetBranch: string;
  tool: RuleTool;
}
