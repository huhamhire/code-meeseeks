import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StoredPullRequest } from '@meebox/shared';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { formatTimestamp } from '../../../../utils/time';
import {
  Avatar,
  makeBitbucketImageFor,
  transformBitbucketUrl,
  mermaidComponents,
} from '../../../common';
import { REVIEWER_STATUS_META, ReviewerStatusIcon } from '../reviewer-status';

interface PrInfoViewProps {
  pr: StoredPullRequest;
}

export function PrInfoView({ pr }: PrInfoViewProps) {
  const { t } = useTranslation();
  // Images embedded in the description body go through the IPC proxy (Bitbucket private resources need PAT auth), consistent with comments/diff
  const mdComponents = useMemo(
    () => ({ ...mermaidComponents, img: makeBitbucketImageFor(pr.localId, pr.url) }),
    [pr.localId, pr.url],
  );

  // The reviewers order produced by each platform's adapter is unstable (GitHub uses Map insertion order,
  // and as review progresses requested_reviewers get removed/appended to the end), so the list jitters every poll.
  // The display layer sorts stably by displayName in lexicographic order, with name as a stable fallback, platform-agnostic.
  const reviewers = useMemo(
    () =>
      [...pr.reviewers].sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name),
      ),
    [pr.reviewers],
  );

  return (
    <div className="pr-info-view">
      <div className="pr-info-content pr-info-layout">
        {/* Left: description (main content); right: timeline + reviewers (metadata sidebar, modeled on PR overview layout) */}
        <div className="pr-info-main">
          {pr.description ? (
            <section className="pr-detail-section">
              <h3>{t('prInfo.description')}</h3>
              <div className="pr-detail-description markdown">
                {/* Bitbucket remote uses \r\n line endings; when remark parses, CR and LF each count as a line break → a single
                    newline gets treated as a paragraph separator, adding blank space between each list item. Normalize to \n */}
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
          ) : (
            <section className="pr-detail-section">
              <h3>{t('prInfo.description')}</h3>
              <p className="muted">{t('prInfo.descriptionEmpty')}</p>
            </section>
          )}
        </div>

        <aside className="pr-info-side">
          <section className="pr-detail-section">
            <h3>{t('prInfo.timeline')}</h3>
            <div className="pr-detail-kv">
              <div className="modal-kv-key">{t('prInfo.createdAt')}</div>
              <div className="modal-kv-val">{formatTimestamp(pr.createdAt, { full: true })}</div>
              <div className="modal-kv-key">{t('prInfo.updatedAt')}</div>
              <div className="modal-kv-val">{formatTimestamp(pr.updatedAt, { full: true })}</div>
              <div className="modal-kv-key">{t('prInfo.recentUpdate')}</div>
              <div className="modal-kv-val">{formatTimestamp(pr.lastSeenAt, { full: true })}</div>
            </div>
          </section>

          <section className="pr-detail-section">
            <h3>{t('prInfo.reviewers', { n: reviewers.length })}</h3>
            {reviewers.length === 0 ? (
              <p className="muted">{t('prInfo.reviewersEmpty')}</p>
            ) : (
              <ul className="reviewer-list">
                {reviewers.map((r) => {
                  const meta = REVIEWER_STATUS_META[r.status];
                  return (
                    <li key={r.name} className="reviewer-item">
                      <span
                        className={`reviewer-icon reviewer-icon-${r.status}`}
                        aria-hidden="true"
                      >
                        <ReviewerStatusIcon status={r.status} />
                      </span>
                      <Avatar
                        connectionId={pr.connectionId}
                        slug={r.slug ?? r.name}
                        displayName={r.displayName}
                        avatarUrl={r.avatarUrl}
                        size={22}
                      />
                      <span className="reviewer-name">{r.displayName}</span>
                      <span className={`pr-activity-chip pr-activity-chip-${meta.chipKind}`}>
                        {t(meta.labelKey)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
