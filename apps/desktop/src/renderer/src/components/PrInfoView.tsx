import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReviewerStatus, StoredPullRequest } from '@pr-pilot/shared';

interface PrInfoViewProps {
  pr: StoredPullRequest;
}

function ReviewerStatusTag({ status }: { status: ReviewerStatus }) {
  if (status === 'approved') return <span className="tag-approved">✓ approved</span>;
  if (status === 'needsWork') return <span className="tag-needs-work">✗ needs work</span>;
  return <span className="muted">pending</span>;
}

export function PrInfoView({ pr }: PrInfoViewProps) {
  return (
    <div className="pr-info-view">
      {pr.description && (
        <section className="pr-detail-section">
          <h3>描述</h3>
          <div className="pr-detail-description markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{pr.description}</ReactMarkdown>
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
