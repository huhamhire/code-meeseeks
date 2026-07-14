// GitHub REST response shapes (only the fields we use). Cross-domain shared data types, extracted here.

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
  /** Conversation (issue) comment count; only present on `/pulls/{n}` detail */
  comments?: number;
  /** Inline review comment count (incl. replies, a reply is itself a review comment); only present on `/pulls/{n}` detail */
  review_comments?: number;
}

export interface GhReview {
  id: number;
  user: GhUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

/**
 * Reaction rollup embedded in GitHub comment responses (counts-only, no per-user). One count per content + total_count.
 * `mine` (whether the current user has reacted) requires querying the `.../reactions` list endpoint separately — see GitHubCommentService.
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

/** A single GitHub reaction (returned by list / create endpoints). */
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
  /** 'file' = a file-level review comment (no line); 'line' (default) = anchored to a line. */
  subject_type?: 'line' | 'file';
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

/** search/issues hit (PR form); repository_url looks like https://api.github.com/repos/{o}/{r} */
export interface GhSearchItem {
  number: number;
  repository_url: string;
  pull_request?: unknown;
}
