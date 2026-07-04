// GitLab REST v4 response shapes (only the fields used). Data types shared across domains, extracted separately here.

export interface GlUser {
  id: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
  web_url?: string;
}

export interface GlDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface GlMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  created_at: string;
  updated_at: string;
  author: GlUser;
  source_branch: string;
  target_branch: string;
  /** head (source branch latest) sha; present in both detail and list */
  sha?: string;
  reviewers?: GlUser[];
  /** 15.6+ rich mergeability enum; old instances may lack it, fall back to merge_status */
  detailed_merge_status?: string;
  merge_status?: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking';
  has_conflicts?: boolean;
  /** only present in single-MR detail; inline comment position and base/head sha need it */
  diff_refs?: GlDiffRefs | null;
  /** user comment (note) count, includes replies, excludes system notes; present in both list and detail */
  user_notes_count?: number;
}

export interface GlApprovals {
  approved_by?: Array<{ user: GlUser }>;
}

export interface GlCommit {
  id: string;
  short_id?: string;
  title?: string;
  message?: string;
  author_name?: string;
  authored_date?: string;
  committer_name?: string;
  committed_date?: string;
  parent_ids?: string[];
  web_url?: string;
}

export interface GlPosition {
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
  old_path?: string;
  new_path?: string;
  old_line?: number | null;
  new_line?: number | null;
  position_type?: string;
}

export interface GlNote {
  id: number;
  type?: 'DiffNote' | 'DiscussionNote' | null;
  body: string;
  author: GlUser;
  created_at: string;
  updated_at: string;
  system?: boolean;
  position?: GlPosition | null;
}

export interface GlDiscussion {
  id: string;
  notes: GlNote[];
}

/** An award emoji (reaction) on a GitLab note. `name` is the GitLab emoji name (e.g. `thumbsup`). */
export interface GlAwardEmoji {
  id: number;
  name: string;
  user: GlUser;
}

export interface GlMetadata {
  version: string;
  enterprise?: boolean;
}

export interface GlVersion {
  version: string;
}
