// Bitbucket Server REST response shapes (only the fields used). Data types shared across domains, extracted here separately.

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
  /**
   * Statistical properties attached to dashboard / list PRs. `commentCount` counts **top-level** comments only (replies not counted) —
   * so it can only serve as a coarse signal for "new top-level comment", unable to sense replies (see poller comment tracking). Field optional for tolerance.
   */
  properties?: {
    commentCount?: number;
    openTaskCount?: number;
    resolvedTaskCount?: number;
  };
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

/**
 * An emoji reaction on a Bitbucket comment (injected by the comment-likes plugin via the comment's `properties.reactions`).
 *
 * Shape verified against real instance responses (official REST docs unclear): `emoticon` gives `shortcut` (e.g. `eyes`) + `url`
 * (twemoji SVG, the filename being the Unicode code point such as `1f440.svg`); `users[]` is the list of reactors; **no `count` field**
 * (count taken from `users.length`). Displaying the emoji decodes the code point from `url` first, falling back to the shortcut name mapping. Fields still marked optional for tolerance.
 */
export interface BitbucketReactionProperty {
  emoticon?: { shortcut?: string; url?: string };
  users?: BitbucketUser[];
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
  /** Extended properties such as reactions (comment-likes plugin injects `reactions`). Shape undocumented, read tolerantly. */
  properties?: { reactions?: BitbucketReactionProperty[] };
}

/**
 * Attachment upload response (POST .../attachments, multipart field `files`). `links.attachment.href` is of the
 * `attachment:<repoId>/<id>` form, which can be embedded directly into comment markdown. Fields taken from observed responses, optional for tolerance.
 */
export interface BitbucketAttachmentUploadResponse {
  attachments?: Array<{
    id?: string | number;
    url?: string;
    links?: { attachment?: { href?: string } };
  }>;
}

export interface BitbucketCommentAnchor {
  diffType?: 'EFFECTIVE' | 'COMMIT' | 'RANGE';
  // line / lineType may be absent for file-level comments (attached to the file rather than a specific line)
  // or orphaned anchors (the anchored line no longer exists) — marked optional; mapBitbucketAnchor degrades accordingly, avoiding a crash from reading undefined.toLowerCase
  line?: number;
  lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT';
  fileType?: 'FROM' | 'TO';
  path: string;
  srcPath?: string;
}

export interface BitbucketCommit {
  id: string; // 40-char SHA
  displayId: string; // short SHA (Bitbucket default 7-12 chars)
  message: string; // full commit message
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
