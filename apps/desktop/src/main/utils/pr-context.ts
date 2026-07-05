import type { PrComment, StoredPullRequest } from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import type { Logger } from 'pino';

interface BuildPrContextOpts {
  pr: StoredPullRequest;
  adapter: PlatformAdapter;
  logger?: Logger;
  /** Take the most recent N comments (top-level + nested replies combined), default 20 */
  maxComments?: number;
  /** Truncate each comment body to N characters, default 300 */
  maxCommentLen?: number;
}

/**
 * Assemble the PR's own non-diff information into a markdown block, injected into pr-agent as
 * EXTRA_INSTRUCTIONS.
 *
 * Includes:
 * - Title
 * - Description (PR.description, written by the author; skipped when empty — this is exactly what
 *   /describe is meant to generate)
 * - Existing comments (up to N, top-level in reverse chronological order + nested replies)
 *
 * The pr-agent local provider won't fetch this information from Bitbucket itself (the local
 * provider only looks at the worktree's git diff), so we must provide it proactively. This block
 * is concatenated with rules.instructions so that both /describe and /review can perceive the
 * background.
 *
 * Fail-safe: comments fetch fails → warn + skip; every field but the title missing → return an
 * empty string (the caller can decide whether to send it).
 */
export async function buildPrContext({
  pr,
  adapter,
  logger,
  maxComments = 20,
  maxCommentLen = 300,
}: BuildPrContextOpts): Promise<string> {
  const sections: string[] = [];

  sections.push(`**Title**: ${pr.title}`);

  const desc = pr.description.trim();
  if (desc) {
    sections.push(`**Description**:\n${desc}`);
  }

  let comments: PrComment[] = [];
  try {
    comments = await adapter.comments.listPullRequestComments(
      { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
      pr.remoteId,
    );
  } catch (err) {
    logger?.warn(
      { err, localId: pr.localId },
      'buildPrContext: listPullRequestComments failed; proceeding without comments',
    );
  }
  const formatted = formatComments(comments, maxComments, maxCommentLen);
  if (formatted.length > 0) {
    sections.push(
      `**Existing comments** (${String(formatted.length)}, newest first):\n${formatted.join('\n')}`,
    );
  }

  // When there's only the title (no description, no comments) it usually means the PR was just
  // opened with no background to speak of; let the caller get an empty string and decide whether
  // to inject, avoiding a useless prefix on the prompt
  if (sections.length === 1 && !desc && comments.length === 0) {
    return '';
  }
  return `## PR context\n\n${sections.join('\n\n')}`;
}

/**
 * Flatten the nested comment tree into a markdown list:
 * - top-level sorted by createdAt in reverse order (newest first)
 * - replies within the same thread follow their parent node, preserving the original order
 * - each line: `<indent>- @<author>[ (file:line)] <YYYY-MM-DD>: <body>`
 * - newlines in body replaced with spaces, truncated to maxLen characters
 */
function formatComments(
  comments: ReadonlyArray<PrComment>,
  maxN: number,
  maxLen: number,
): string[] {
  const sorted = comments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out: string[] = [];
  const walk = (c: PrComment, depth: number): void => {
    if (out.length >= maxN) return;
    const indent = '  '.repeat(depth);
    const anchor = c.anchor ? ` (${c.anchor.path}:${String(c.anchor.line)})` : '';
    const date = c.createdAt.slice(0, 10);
    const raw = c.body.replace(/\s+/g, ' ').trim();
    const body = raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
    out.push(`${indent}- @${c.author.displayName}${anchor} ${date}: ${body}`);
    for (const r of c.replies) walk(r, depth + 1);
  };
  for (const c of sorted) walk(c, 0);
  return out;
}
