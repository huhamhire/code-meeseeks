import type { LocalPrStatus, StoredPullRequest } from '@pr-pilot/shared';

interface MainPaneProps {
  pr: StoredPullRequest | null;
  hasConnections: boolean;
  onSetStatus: (status: LocalPrStatus) => void;
}

export function MainPane({ pr, hasConnections, onSetStatus }: MainPaneProps) {
  if (!pr) {
    return (
      <main className="main">
        <div className="main-empty">
          {hasConnections ? (
            <div>
              <p>← 从左侧选择一个 PR</p>
              <p className="muted" style={{ marginTop: 12 }}>
                M2 起这里会替换成 Monaco diff viewer + Findings drawer
              </p>
            </div>
          ) : (
            <div>
              <p>尚未配置任何连接</p>
              <p className="muted" style={{ marginTop: 12 }}>
                点右上"设置"→"编辑 config.yaml"添加 Bitbucket Server 连接
              </p>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <div className="pr-detail">
        <div className="pr-detail-head">
          <h2>
            <span className="muted">#{pr.remoteId}</span> {pr.title}
          </h2>
          <div className="pr-detail-meta">
            <strong>
              {pr.repo.projectKey}/{pr.repo.repoSlug}
            </strong>
            <span> · 作者：{pr.author.displayName}</span>
            <span>
              {' '}
              · {pr.sourceRef.displayId} → {pr.targetRef.displayId}
            </span>
            <span> · 本地状态：</span>
            <span className={`status-tag status-${pr.localStatus}`}>{pr.localStatus}</span>
          </div>
        </div>

        <div className="pr-detail-actions">
          <a className="btn btn-primary" href={pr.url} target="_blank" rel="noreferrer">
            在浏览器打开
          </a>
          {pr.localStatus !== 'skipped' && (
            <button className="btn" type="button" onClick={() => onSetStatus('skipped')}>
              标记跳过
            </button>
          )}
          {pr.localStatus !== 'reviewed' && (
            <button className="btn" type="button" onClick={() => onSetStatus('reviewed')}>
              标记已评
            </button>
          )}
          {pr.localStatus !== 'pending' && (
            <button className="btn" type="button" onClick={() => onSetStatus('pending')}>
              重置为待处理
            </button>
          )}
        </div>

        {pr.description && (
          <section className="pr-detail-section">
            <h3>描述</h3>
            <p className="pr-detail-description">{pr.description}</p>
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
                  {r.displayName}{' '}
                  <span className={r.approved ? 'tag-approved' : 'muted'}>
                    {r.approved ? '✓ approved' : 'pending'}
                  </span>
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

        <p className="muted pr-detail-footer">
          M2 起会在这里嵌 Monaco diff + Findings drawer + pr-agent 评论编辑。
        </p>
      </div>
    </main>
  );
}
