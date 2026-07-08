import { useMemo, useState } from 'react';
import type {
  PlatformCapabilities,
  PlatformUser,
  PrComment,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../../../../../api';
import { ChatIcon } from '../../../../common';
import { CommentComposer } from '../comments/CommentComposer';
import { CommentItem } from '../comments/CommentItem';

/**
 * File-level comments for the currently open diff file: comments anchored to the whole file (no line) — which the
 * line-based inline zones can't host — plus a "comment on this file" entry. Rendered above the diff editor.
 *
 * Reuses {@link CommentItem} / {@link CommentComposer} so file-level comments have the **same** interactions (reactions,
 * mention, reply, edit, delete) as every other comment surface (see the comment-interaction consistency rule). The
 * compose entry is gated on the `fileLevelComments` capability (Bitbucket / GitHub; GitLab has none).
 */
export function FileCommentStrip({
  pr,
  path,
  oldPath,
  comments,
  capabilities,
  hardBreaks,
  reactionsMode,
  mentionCandidates,
  attachmentsEnabled = false,
  userSearchEnabled = false,
  readOnly = false,
}: {
  pr: StoredPullRequest;
  path: string;
  oldPath?: string;
  comments: PrComment[];
  capabilities?: PlatformCapabilities;
  hardBreaks: boolean;
  reactionsMode?: 'fixed' | 'free';
  mentionCandidates?: PlatformUser[];
  attachmentsEnabled?: boolean;
  userSearchEnabled?: boolean;
  readOnly?: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState(false);
  // The file's project-relative path as breadcrumb segments (last = the file name).
  const segments = useMemo(() => path.split('/'), [path]);
  // Whole-breadcrumb click copies the relative path (VS Code-style, no per-segment navigation), with a brief ✓.
  const copyPath = (): void => {
    void navigator.clipboard.writeText(path).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard denied — best-effort, ignore */
      },
    );
  };
  const fileComments = useMemo(
    () =>
      comments.filter(
        (c) =>
          c.anchor &&
          c.anchor.line == null &&
          (c.anchor.path === path || (oldPath != null && c.anchor.path === oldPath)),
      ),
    [comments, path, oldPath],
  );
  const canComment = !readOnly && (capabilities?.fileLevelComments ?? false);
  // Nothing to show and nothing to add → render nothing (keep the diff clean for files without file-level comments).
  if (fileComments.length === 0 && !canComment) return null;

  return (
    <div className="diff-file-comments">
      <div className="diff-file-comments-head">
        <button type="button" className="diff-file-crumbs" title={path} onClick={copyPath}>
          {segments.map((seg, i) => (
            <span key={`${String(i)}-${seg}`} className="diff-file-crumb">
              {i > 0 && (
                <span className="diff-file-crumb-sep" aria-hidden="true">
                  ›
                </span>
              )}
              <span className={i === segments.length - 1 ? 'diff-file-crumb-name' : undefined}>
                {seg}
              </span>
            </span>
          ))}
          {copied && (
            <span className="diff-file-crumb-copied" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
        {canComment && !composing && (
          <button
            type="button"
            className="diff-file-comment-btn"
            onClick={() => setComposing(true)}
          >
            <ChatIcon size={15} />
          </button>
        )}
      </div>
      {(fileComments.length > 0 || composing) && (
        <div className="diff-file-comments-body">
          {fileComments.length > 0 && (
            <ul className="pr-comments-list">
              {fileComments.map((c) => (
                <CommentItem
                  key={c.remoteId}
                  comment={c}
                  pr={pr}
                  depth={0}
                  hardBreaks={hardBreaks}
                  reactionsMode={reactionsMode}
                  mentionCandidates={mentionCandidates}
                  attachmentsEnabled={attachmentsEnabled}
                  userSearchEnabled={userSearchEnabled}
                  readOnly={readOnly}
                />
              ))}
            </ul>
          )}
          {composing && (
            <CommentComposer
              prLocalId={pr.localId}
              mentionCandidates={mentionCandidates}
              platform={pr.platform}
              attachmentsEnabled={attachmentsEnabled}
              userSearchEnabled={userSearchEnabled}
              onSubmit={(body) =>
                invoke('comments:createFile', { localId: pr.localId, path, body })
              }
              onCancel={() => setComposing(false)}
              onPosted={() => setComposing(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
