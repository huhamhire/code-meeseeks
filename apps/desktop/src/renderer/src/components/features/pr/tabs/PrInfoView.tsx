import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StoredPullRequest } from '@meebox/shared';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
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
      <div className="pr-info-content pr-info-layout">
        {/* 左：描述（主内容）；右：时间线 + 评审者（元信息侧栏，参考 PR overview 布局） */}
        <div className="pr-info-main">
          {pr.description ? (
            <section className="pr-detail-section">
              <h3>{t('prInfo.description')}</h3>
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
              <div className="modal-kv-val">{new Date(pr.createdAt).toLocaleString()}</div>
              <div className="modal-kv-key">{t('prInfo.updatedAt')}</div>
              <div className="modal-kv-val">{new Date(pr.updatedAt).toLocaleString()}</div>
              <div className="modal-kv-key">{t('prInfo.recentUpdate')}</div>
              <div className="modal-kv-val">{new Date(pr.lastSeenAt).toLocaleString()}</div>
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
