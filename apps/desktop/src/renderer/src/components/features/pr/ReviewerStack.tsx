import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Reviewer, ReviewerStatus } from '@meebox/shared';
import { Avatar } from '../../common';
import { REVIEWER_STATUS_META, ReviewerBadgeGlyph } from './reviewer-status';

const STACK_AVATAR_SIZE = 32;
// 总数 ≤ MAX_VISIBLE 全显；超出则显示 (MAX_VISIBLE-1) 个头像 + 一个「+n」溢出项
const MAX_VISIBLE = 4;
// 排序优先级：needsWork（待处理，最该被看到）> approved > 待评审
const STATUS_RANK: Record<ReviewerStatus, number> = { needsWork: 0, approved: 1, unapproved: 2 };

/**
 * PR 头部右上角的 reviewer 头像栈（Bitbucket 风格，略重叠）：
 * - 过滤掉当前用户自己；needsWork > approved > 待评审 优先排序，同级按 displayName 稳定排序
 * - approved 右上角绿勾、needsWork 右上角琥珀叹号角标（待评审无角标）
 * - 至多展示 4 个；超出显示 3 个 + 「+n」，点击「+n」下拉展示其余 reviewer（头像 + 名 + 决断 chip）
 * - 直接展示的头像 hover 出名字（走 Avatar 自带 title）
 * 过滤后无人则不渲染。
 */
export function ReviewerStack({
  reviewers,
  connectionId,
  currentUserName,
}: {
  reviewers: Reviewer[];
  connectionId: string;
  currentUserName?: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // 下拉定位 + 外点关闭 + 窗口变化重算（与 DiffScopeSelect 同套，fixed + portal 避免被裁切）
  useEffect(() => {
    if (!open) return;
    const compute = (): void => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    compute();
    const onDoc = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt) || menuRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);

  const sorted = reviewers
    .filter((r) => !currentUserName || r.name !== currentUserName)
    .slice()
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.displayName.localeCompare(b.displayName) ||
        a.name.localeCompare(b.name),
    );

  if (sorted.length === 0) return null;

  const overflow = sorted.length > MAX_VISIBLE;
  const visible = overflow ? sorted.slice(0, MAX_VISIBLE - 1) : sorted;
  const hidden = overflow ? sorted.slice(MAX_VISIBLE - 1) : [];
  // 重叠下让左侧头像压住右侧（z 递减），使各自的右上角角标不被相邻头像遮挡
  const topZ = sorted.length + 1;

  return (
    <div className="reviewer-stack">
      {visible.map((r, i) => (
        <span key={r.name} className="reviewer-stack-item" style={{ zIndex: topZ - i }}>
          <Avatar
            connectionId={connectionId}
            slug={r.slug ?? r.name}
            displayName={r.displayName}
            avatarUrl={r.avatarUrl}
            size={STACK_AVATAR_SIZE}
          />
          {(r.status === 'approved' || r.status === 'needsWork') && (
            <span
              className={`reviewer-stack-badge reviewer-stack-badge-${r.status}`}
              aria-hidden="true"
            >
              <ReviewerBadgeGlyph status={r.status} size={14} />
            </span>
          )}
        </span>
      ))}
      {overflow && (
        <button
          ref={triggerRef}
          type="button"
          className={`reviewer-stack-more${open ? ' open' : ''}`}
          style={{ zIndex: 1 }}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={t('mainPane.moreReviewers', { n: hidden.length })}
        >
          +{hidden.length}
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="reviewer-stack-menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            role="menu"
          >
            {hidden.map((r) => {
              const meta = REVIEWER_STATUS_META[r.status];
              return (
                <div key={r.name} className="reviewer-stack-menu-item" role="menuitem">
                  <Avatar
                    connectionId={connectionId}
                    slug={r.slug ?? r.name}
                    displayName={r.displayName}
                    avatarUrl={r.avatarUrl}
                    size={22}
                  />
                  <span className="reviewer-stack-menu-name">{r.displayName}</span>
                  <span className={`pr-activity-chip pr-activity-chip-${meta.chipKind}`}>
                    {t(meta.labelKey)}
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
