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
}

export interface GhReview {
  id: number;
  user: GhUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

export interface GhIssueComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url?: string;
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
