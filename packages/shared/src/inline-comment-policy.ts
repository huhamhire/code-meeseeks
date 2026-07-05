/**
 * Different code platforms vary widely in the "anchor line range" they allow for inline comments:
 *
 * - Bitbucket Server / Data Center: strict — the `/comments` endpoint requires anchor.line
 *   to fall within the diff hunk range (including context lines). Anchoring to a line outside the hunk gets a 400 from Bitbucket.
 * - GitHub / GitLab: permissive — a comment can start on any line within the diff view
 *   (GitHub's multi-file review comment also anchors by file:line but with a looser range).
 *
 * Abstract "which line can take a new inline comment" into a platform-specific policy, so DiffView
 * filters by the profile chosen from the current PR's platform when rendering the hover '+' glyph; the same ruleset is later reused
 * for pre-validation at Bitbucket publishInline submit time to avoid a 400.
 *
 * Hunk info comes from monaco DiffEditor's getLineChanges(), without extra IPC:
 * - ILineChange.{original,modified}{Start,End}LineNumber → DiffHunkRange
 * - the conversion is done locally in DiffView; policy only accepts the normalized structure
 */
import type { PlatformKind } from './platform.js';

/**
 * Line range of a single diff hunk on the original / modified sides. inclusive.
 * - modified=null: pure deletion (no corresponding line on the modified side)
 * - original=null: pure addition (no corresponding line on the original side)
 */
export interface DiffHunkRange {
  modified: { start: number; end: number } | null;
  original: { start: number; end: number } | null;
}

export interface InlineCommentPolicy {
  /** Profile display name; the tooltip can reference it when hover '+' is disabled */
  label: string;
  /**
   * Decide whether (side, line) allows a new inline comment. hunks is the list of change ranges for the whole file.
   * Note: the policy only checks whether the anchor line is a valid landing spot, not the "existing comment / draft occupied" case; occupancy
   * is still decided in DiffView's occupied set
   */
  isLineAllowed(
    hunks: ReadonlyArray<DiffHunkRange>,
    side: 'old' | 'new',
    line: number,
  ): boolean;
}

/**
 * Factory: a policy whose allowed lines are "hunk range ± context lines". context=0 means strictly inside the hunk;
 * Bitbucket in practice allows comments within 10 lines above/below the change (including context lines)
 */
function makeContextRangePolicy(label: string, context: number): InlineCommentPolicy {
  return {
    label,
    isLineAllowed(hunks, side, line) {
      for (const h of hunks) {
        const range = side === 'new' ? h.modified : h.original;
        if (range && line >= range.start - context && line <= range.end + context) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Bitbucket profile: allows lines within **10 lines above/below** the change area (aligned with Bitbucket Web UI behavior — a line
 * too far from the hunk gets a 400 from the /comments endpoint). Added lines (modified side) anchor to the modified range,
 * deleted lines (original side) anchor to the original range. Bitbucket's fileType=FROM/TO field is later translated by side at
 * publishInline time
 */
const bitbucketPolicy = makeContextRangePolicy(
  'Bitbucket Server: 变更上下 10 行内可加评论',
  10,
);

/** Permissive profile: any line allowed (GitHub / GitLab) */
const permissivePolicy: InlineCommentPolicy = {
  label: '任意行可加评论',
  isLineAllowed: () => true,
};

export const INLINE_COMMENT_POLICIES: Readonly<Record<PlatformKind, InlineCommentPolicy>> = {
  github: permissivePolicy,
  'bitbucket-server': bitbucketPolicy,
  gitlab: permissivePolicy,
};

/** Fall back to the permissive policy when the platform value is unknown, to avoid fully hiding + when a new platform is integrated */
export function policyForPlatform(platform: PlatformKind): InlineCommentPolicy {
  return INLINE_COMMENT_POLICIES[platform] ?? permissivePolicy;
}
