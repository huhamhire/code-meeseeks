import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReviewerStatus, StoredPullRequest } from '@meebox/shared';
import { REMOTE_REHYPE_PLUGINS } from '../markdown';
import { makeBitbucketImageFor, transformBitbucketUrl } from './BitbucketImage';
import { mermaidComponents } from './markdownMermaid';

interface PrInfoViewProps {
  pr: StoredPullRequest;
}

function ReviewerStatusTag({ status }: { status: ReviewerStatus }) {
  if (status === 'approved') return <span className="tag-approved">✓ approved</span>;
  if (status === 'needsWork') return <span className="tag-needs-work">✗ needs work</span>;
  return <span className="muted">pending</span>;
}

export function PrInfoView({ pr }: PrInfoViewProps) {
  // 描述 body 内嵌图片走 IPC 代理 (Bitbucket 私有资源需 PAT 鉴权)，与评论/diff 一致
  const mdComponents = useMemo(
    () => ({ ...mermaidComponents, img: makeBitbucketImageFor(pr.localId) }),
    [pr.localId],
  );

  return (
    <div className="pr-info-view">
      {pr.description && (
        <section className="pr-detail-section">
          <h3>描述</h3>
          <div className="pr-detail-description markdown">
            {/* Bitbucket 远端用 \r\n 行尾，remark 解析时 CR 跟 LF 各算一次换行 → 单换行
                被当成段落分隔，每个 list item 之间多一段空白。归一化成 \n */}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={REMOTE_REHYPE_PLUGINS}
              components={mdComponents}
              urlTransform={transformBitbucketUrl}
            >
              {pr.description.replace(/\r\n?/g, '\n')}
            </ReactMarkdown>
          </div>
        </section>
      )}

      <section className="pr-detail-section">
        <h3>Reviewers ({pr.reviewers.length})</h3>
        {pr.reviewers.length === 0 ? (
          <p className="muted">无</p>
        ) : (
          <ul className="reviewer-list">
            {pr.reviewers.map((r) => (
              <li key={r.name}>
                {r.displayName} <ReviewerStatusTag status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pr-detail-section">
        <h3>时间线</h3>
        <div className="pr-detail-kv">
          <div className="modal-kv-key">远端创建</div>
          <div className="modal-kv-val">{new Date(pr.createdAt).toLocaleString()}</div>
          <div className="modal-kv-key">远端更新</div>
          <div className="modal-kv-val">{new Date(pr.updatedAt).toLocaleString()}</div>
          <div className="modal-kv-key">本地首次发现</div>
          <div className="modal-kv-val">{new Date(pr.discoveredAt).toLocaleString()}</div>
          <div className="modal-kv-key">最近一次 poll 看到</div>
          <div className="modal-kv-val">{new Date(pr.lastSeenAt).toLocaleString()}</div>
        </div>
      </section>
    </div>
  );
}
