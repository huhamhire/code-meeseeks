import type { PlatformUser, PrComment, PrCommentAnchor } from '@meebox/shared';

/**
 * 「未读」检测的纯逻辑：在 PR 评论树里找出**与当前用户相关**的最新一条他人评论的时间戳。
 * 相关 = ① 正文 @我（按 name / slug 任一 handle 匹配），或 ② 回复我（父评论作者是我）。自己写的评论不计。
 *
 * 返回最新相关评论的 createdAt（ISO）；无则 null。调用方（poll）把它与历史 `lastMentionAt` 取较大值维护成
 * 单调游标；是否「未读」由读取时与已读水位 `lastReadAt` 比较决定（见 pr-state.computeUnread）——故此处不关心水位。
 *
 * 仅在 poll 识别到 PR 内容变更（updatedAt 跳变）时调用——避免对每个跟踪 PR 每轮都拉评论，成本与活动量成正比。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 正文是否 @ 了任一 handle。要求 `@` 前不是单词字符（排除邮箱 `a@h` 之类），`@handle` 后不接单词字符 / `.` / `-`
 * （排除 `@handle2` 误命中 `@handle`）。大小写不敏感。
 */
function mentionsAnyHandle(body: string, handles: readonly string[]): boolean {
  for (const h of handles) {
    if (!h) continue;
    const re = new RegExp(`(?<![\\w])@${escapeRegExp(h)}(?![\\w.-])`, 'i');
    if (re.test(body)) return true;
  }
  return false;
}

/** 与我相关的评论命中：被回复（父评论作者是我）优先于被 @（reply 是更强的相关关系）。 */
export type MentionKind = 'mention' | 'reply';

/**
 * 评论树里一条「@我 / 回复我」他人评论的命中：时间 + 类型 + 作者（系统通知头像 / 发起人）+ 评论定位
 * （`commentRemoteId` 与 `anchor`：通知点击跳转用——inline 评论 anchor 非空可跳 diff 行，summary 评论 anchor 为 null）。
 */
export interface MentionHit {
  at: string;
  kind: MentionKind;
  author: PlatformUser;
  commentRemoteId: string;
  anchor: PrCommentAnchor | null;
}

/**
 * 评论树里所有「@我 / 回复我」他人评论的命中（时间 + 类型），深度优先、自然到达顺序（未排序）。
 * 相关判定：① 父评论作者是我（reply），或 ② 正文 @我（mention）；自己写的不计。两者都满足时记为 reply。
 *
 * - `me`：当前用户（poll 时从 adapter 缓存身份取）。handle 取 name + slug（去重、非空）。
 *
 * 调用方（poll）据此取最新游标、据已读水位计未读条数（见 pr-state.computeUnreadMentionCount），
 * 并按类型投影系统通知事件。
 */
export function collectMentionsToMe(
  comments: readonly PrComment[],
  me: PlatformUser,
): MentionHit[] {
  const handles = [me.name, me.slug].filter((x): x is string => !!x);
  const lowered = new Set(handles.map((h) => h.toLowerCase()));
  const isMe = (u: PlatformUser): boolean =>
    lowered.has(u.name.toLowerCase()) || (u.slug ? lowered.has(u.slug.toLowerCase()) : false);

  const hits: MentionHit[] = [];
  const walk = (list: readonly PrComment[], parentIsMe: boolean): void => {
    for (const c of list) {
      const authoredByMe = isMe(c.author);
      if (!authoredByMe) {
        const base = { at: c.createdAt, author: c.author, commentRemoteId: c.remoteId, anchor: c.anchor };
        if (parentIsMe) hits.push({ ...base, kind: 'reply' });
        else if (mentionsAnyHandle(c.body, handles)) hits.push({ ...base, kind: 'mention' });
      }
      if (c.replies?.length) walk(c.replies, authoredByMe);
    }
  };
  walk(comments, false);
  return hits;
}

/** 评论树里一条**他人**评论（不限是否 @我 / 回复我）：时间 + 作者 + 定位。用于「我创建的」PR 的新评论通知。 */
export interface CommentHit {
  at: string;
  author: PlatformUser;
  commentRemoteId: string;
  anchor: PrCommentAnchor | null;
}

/**
 * 评论树里**所有他人评论**（作者非当前用户）的命中，深度优先、自然到达顺序（未排序）。与
 * {@link collectMentionsToMe} 不同：不筛 @我 / 回复我，收全部他人评论——供「我创建的」PR 的「收到新评论」通知
 * 用（作者本人的评论不计，故不会因自己评论而误报）。
 */
export function collectCommentsFromOthers(
  comments: readonly PrComment[],
  me: PlatformUser,
): CommentHit[] {
  const handles = [me.name, me.slug].filter((x): x is string => !!x);
  const lowered = new Set(handles.map((h) => h.toLowerCase()));
  const isMe = (u: PlatformUser): boolean =>
    lowered.has(u.name.toLowerCase()) || (u.slug ? lowered.has(u.slug.toLowerCase()) : false);

  const hits: CommentHit[] = [];
  const walk = (list: readonly PrComment[]): void => {
    for (const c of list) {
      if (!isMe(c.author)) {
        hits.push({
          at: c.createdAt,
          author: c.author,
          commentRemoteId: c.remoteId,
          anchor: c.anchor,
        });
      }
      if (c.replies?.length) walk(c.replies);
    }
  };
  walk(comments);
  return hits;
}

/**
 * 评论树里所有「@我 / 回复我」他人评论的 createdAt（ISO）列表。基于 {@link collectMentionsToMe}。
 */
export function collectCommentsToMeAt(
  comments: readonly PrComment[],
  me: PlatformUser,
): string[] {
  return collectMentionsToMe(comments, me).map((h) => h.at);
}

/**
 * 评论树里「@我 / 回复我」的最新他人评论的 createdAt（ISO）；无则 null。基于 {@link collectCommentsToMeAt}。
 */
export function latestCommentToMeAt(
  comments: readonly PrComment[],
  me: PlatformUser,
): string | null {
  let latest: string | null = null;
  for (const iso of collectCommentsToMeAt(comments, me)) {
    if (latest === null || Date.parse(iso) > Date.parse(latest)) latest = iso;
  }
  return latest;
}
