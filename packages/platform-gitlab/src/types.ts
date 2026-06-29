// GitLab REST v4 响应形状（仅取用到的字段）。跨领域共享的数据类型，单独抽取于此。

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
  /** head（源分支最新）sha；详情与列表都带 */
  sha?: string;
  reviewers?: GlUser[];
  /** 15.6+ 的丰富可合并枚举；旧实例可能缺，退 merge_status */
  detailed_merge_status?: string;
  merge_status?: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking';
  has_conflicts?: boolean;
  /** 仅单 MR 详情带；行内评论 position 与 base/head sha 需要它 */
  diff_refs?: GlDiffRefs | null;
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

/** GitLab note 上的一条 award emoji（反应）。`name` 为 GitLab emoji 名（如 `thumbsup`）。 */
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
