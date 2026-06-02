import type { PlatformAdapter, PrComment, StoredPullRequest } from '@pr-pilot/shared';
import type { Logger } from 'pino';

interface BuildPrContextOpts {
  pr: StoredPullRequest;
  adapter: PlatformAdapter;
  logger?: Logger;
  /** 取最近 N 条 comment (top-level + 嵌套 replies 合计)，默认 20 */
  maxComments?: number;
  /** 每条 comment body 截到 N 字符，默认 300 */
  maxCommentLen?: number;
}

/**
 * 把 PR 自身的非 diff 维度信息拼成一段 markdown，注给 pr-agent 作 EXTRA_INSTRUCTIONS。
 *
 * 包含：
 * - 标题
 * - 描述（PR.description，作者写的；为空时跳过 —— 这正是 /describe 要生成的内容）
 * - 已有评论（按 top-level 时间倒序取最多 N 条 + 嵌套 replies）
 *
 * pr-agent local provider 自己不会去 BBS 拉这些信息（local provider 只看 worktree
 * 的 git diff），所以必须我们这边主动提供。这段会跟 rules.instructions 拼接，让
 * /describe / /review 都能感知背景。
 *
 * 失败 safe：comments fetch 失败 → warn + 跳过；标题以外字段都缺 → 返回空串
 * (调用方可以判断是否要发)。
 */
export async function buildPrContext({
  pr,
  adapter,
  logger,
  maxComments = 20,
  maxCommentLen = 300,
}: BuildPrContextOpts): Promise<string> {
  const sections: string[] = [];

  sections.push(`**标题**: ${pr.title}`);

  const desc = pr.description.trim();
  if (desc) {
    sections.push(`**描述**:\n${desc}`);
  }

  let comments: PrComment[] = [];
  try {
    comments = await adapter.listPullRequestComments(
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
      `**已有评论** (${String(formatted.length)} 条，最新在前):\n${formatted.join('\n')}`,
    );
  }

  // 只有 title 一项时（无描述、无评论）通常意味着 PR 刚开，没什么背景信息可言；
  // 让调用方拿到空串决定是否注入，避免给 prompt 加无用前缀
  if (sections.length === 1 && !desc && comments.length === 0) {
    return '';
  }
  return `## PR 上下文\n\n${sections.join('\n\n')}`;
}

/**
 * 把嵌套评论树拍扁为 markdown 列表：
 * - top-level 按 createdAt 倒序 (最新在前)
 * - 同一 thread 内 replies 跟父节点，保留原顺序
 * - 每行：`<indent>- @<author>[ (file:line)] <YYYY-MM-DD>: <body>`
 * - body 中的换行替换成空格，截到 maxLen 字符
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
