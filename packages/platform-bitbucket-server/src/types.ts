// Bitbucket Server REST 响应形状（仅取用到的字段）。跨领域共享的数据类型，单独抽取于此。

export interface BitbucketUser {
  name: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  slug: string;
}

export interface BitbucketRef {
  id: string;
  displayId: string;
  latestCommit: string;
  type: 'BRANCH' | 'TAG';
  repository: {
    slug: string;
    name: string;
    project: { key: string; name: string };
  };
}

export interface BitbucketParticipant {
  user: BitbucketUser;
  role: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  status?: 'UNAPPROVED' | 'APPROVED' | 'NEEDS_WORK';
}

export interface BitbucketPullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  open: boolean;
  closed: boolean;
  draft?: boolean;
  createdDate: number;
  updatedDate: number;
  fromRef: BitbucketRef;
  toRef: BitbucketRef;
  author: BitbucketParticipant;
  reviewers: BitbucketParticipant[];
  links: { self: Array<{ href: string }> };
}

export interface BitbucketApplicationProperties {
  version: string;
  buildNumber: string;
  displayName: string;
}

export interface BitbucketMergeStatus {
  canMerge: boolean;
  conflicted: boolean;
  outcome: 'CLEAN' | 'CONFLICTED' | 'CONFLICTED_AND_AHEAD' | string;
  vetoes?: Array<{ summaryMessage: string; detailedMessage?: string }>;
}

export interface BitbucketComment {
  id: number;
  version: number;
  text: string;
  author: BitbucketUser;
  createdDate: number;
  updatedDate: number;
  comments?: BitbucketComment[];
  parent?: { id: number };
}

export interface BitbucketCommentAnchor {
  diffType?: 'EFFECTIVE' | 'COMMIT' | 'RANGE';
  // line / lineType 对文件级评论（挂在文件而非具体行）或孤儿 anchor（锚定行已不存在）
  // 可能缺省 —— 标可选，mapBitbucketAnchor 据此降级，避免读 undefined.toLowerCase 崩
  line?: number;
  lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT';
  fileType?: 'FROM' | 'TO';
  path: string;
  srcPath?: string;
}

export interface BitbucketCommit {
  id: string; // 40-char SHA
  displayId: string; // 短 SHA (Bitbucket 默认 7-12 chars)
  message: string; // 完整 commit message
  author: { name: string; emailAddress?: string };
  authorTimestamp: number; // epoch ms
  committer: { name: string; emailAddress?: string };
  committerTimestamp: number; // epoch ms
  parents: Array<{ id: string; displayId: string }>;
}

export interface BitbucketActivity {
  id: number;
  createdDate: number;
  user: BitbucketUser;
  action: string;
  commentAction?: 'ADDED' | 'UPDATED' | 'DELETED' | 'REPLIED';
  comment?: BitbucketComment;
  commentAnchor?: BitbucketCommentAnchor;
}
