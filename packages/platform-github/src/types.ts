// GitHub REST 响应形状（仅取用到的字段）。跨领域共享的数据类型，单独抽取于此。

export interface GhUser {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface GhRepoRef {
  ref: string;
  sha: string;
  repo: { name: string; owner: { login: string } } | null;
}

export interface GhPull {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: GhUser;
  head: GhRepoRef;
  base: GhRepoRef;
  requested_reviewers?: GhUser[];
  mergeable?: boolean | null;
  mergeable_state?: string;
  /** 会话（issue）评论数；仅 `/pulls/{n}` 详情带 */
  comments?: number;
  /** 行内评审评论数（含回复，回复本身即 review comment）；仅 `/pulls/{n}` 详情带 */
  review_comments?: number;
}

export interface GhReview {
  id: number;
  user: GhUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

/**
 * GitHub 评论响应内嵌的反应聚合（counts-only，无 per-user）。每种 content 一个计数 + total_count。
 * `mine`（当前用户是否已反应）需另查 `.../reactions` 列表端点——见 GitHubCommentService。
 */
export interface GhReactionRollup {
  total_count: number;
  '+1': number;
  '-1': number;
  laugh: number;
  hooray: number;
  confused: number;
  heart: number;
  rocket: number;
  eyes: number;
}

/** GitHub 单条反应（列表 / 创建端点返回）。 */
export interface GhReaction {
  id: number;
  user: GhUser | null;
  content: string;
}

export interface GhIssueComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url?: string;
  reactions?: GhReactionRollup;
}

export interface GhReviewComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
  updated_at: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number | null;
  in_reply_to_id?: number;
  html_url?: string;
  reactions?: GhReactionRollup;
}

export interface GhCommit {
  sha: string;
  html_url?: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  parents: Array<{ sha: string }>;
  author: GhUser | null;
  committer: GhUser | null;
}

/** search/issues 命中项（PR 形态）；repository_url 形如 https://api.github.com/repos/{o}/{r} */
export interface GhSearchItem {
  number: number;
  repository_url: string;
  pull_request?: unknown;
}
