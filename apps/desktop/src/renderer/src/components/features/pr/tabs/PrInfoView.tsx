import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReviewerStatus, StoredPullRequest } from '@meebox/shared';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { makeBitbucketImageFor, transformBitbucketUrl } from '../../../common/BitbucketImage';
import { mermaidComponents } from '../../../common/markdownMermaid';

interface PrInfoViewProps {
  pr: StoredPullRequest;
}

function ReviewerStatusTag({ status }: { status: ReviewerStatus }) {
  const { t } = useTranslation();
  if (status === 'approved') return <span className="tag-approved">✓ {t('prStatus.approved')}</span>;
  if (status === 'needsWork')
    return <span className="tag-needs-work">✗ {t('prStatus.needsWork')}</span>;
  return <span className="muted">{t('prStatus.pending')}</span>;
}

export function PrInfoView({ pr }: PrInfoViewProps) {
  // 描述 body 内嵌图片走 IPC 代理 (Bitbucket 私有资源需 PAT 鉴权)，与评论/diff 一致
  const mdComponents = useMemo(
    () => ({ ...mermaidComponents, img: makeBitbucketImageFor(pr.localId, pr.url) }),
    [pr.localId, pr.url],
  );

  // 各平台 adapter 产出的 reviewers 顺序不稳定（GitHub 按 Map 插入序，随评审推进
  // requested_reviewers 会被移除/补到末尾），每次 poll 列表抖动。展示层按 displayName
  // 字典序固定排序，name 兜底兜稳，与平台无关。
  const reviewers = useMemo(
    () =>
      [...pr.reviewers].sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name),
      ),
    [pr.reviewers],
  );

  return (
    <div className="pr-info-view">
      <div className="pr-info-content">
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
          <h3>Reviewers ({reviewers.length})</h3>
          {reviewers.length === 0 ? (
            <p className="muted">无</p>
          ) : (
            <ul className="reviewer-list">
              {reviewers.map((r) => (
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
    </div>
  );
}
