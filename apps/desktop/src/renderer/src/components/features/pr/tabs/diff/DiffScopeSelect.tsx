import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import type { PrCommit } from '@meebox/shared';
import { Avatar } from '../../../../common/Avatar';
import { ChevronIcon, CommitIcon, PullRequestIcon } from '../../../../common/icons';
import { formatRelativeTime } from '../comments/CommentItem';
import type { DiffScope } from './diff-types';

/**
 * 变更范围选择器：文件树头部「<n> 个文件 · 全部变更 / <commit>」，点击展开下拉切换查看范围。
 * commit 列表懒加载（首次展开才拉）。选「全部变更」= PR 全量 diff；选某 commit = 该 commit
 * 的 parent..sha 只读 diff。
 */
export function DiffScopeSelect({
  fileCount,
  scope,
  commits,
  connectionId,
  onOpen,
  onPick,
}: {
  fileCount: number;
  scope: DiffScope;
  commits: PrCommit[] | null;
  connectionId: string;
  onOpen: () => void;
  onPick: (scope: DiffScope) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // 下拉用 fixed 定位 + portal 挂到 body：否则会被 .diff-file-list 的 overflow 裁切、被右侧 Monaco 盖住。
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 菜单整体拉宽：不小于触发器宽度，且给 commit 主题留足空间
    setMenuPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 440) });
  }, []);
  useEffect(() => {
    if (!open) return;
    computePos();
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    // 触发器在文件树头部（不随文件列表滚动），但窗口缩放 / 外层滚动时重算位置
    const onReflow = (): void => computePos();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, computePos]);

  const scopeLabel = scope.kind === 'all' ? t('diffView.scopeAll') : scope.abbreviatedSha;
  const toggle = (): void => {
    setOpen((o) => {
      const next = !o;
      if (next) onOpen();
      return next;
    });
  };
  return (
    <div className="diff-scope-select" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="diff-scope-trigger"
        onClick={toggle}
        title={scope.kind === 'commit' ? scope.subject : undefined}
        aria-expanded={open}
      >
        <span className="diff-scope-label">
          {t('diffView.fileCount', { count: fileCount })} · {scopeLabel}
        </span>
        <ChevronIcon className={open ? 'diff-scope-chevron open' : 'diff-scope-chevron'} />
      </button>
      {open &&
        menuPos &&
        createPortal(
          <ul
            ref={menuRef}
            className="diff-scope-menu"
            role="listbox"
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          >
            {/* 「全部变更」：标题 + 提交数副行（参考 Bitbucket 两行布局） */}
            <li>
              <button
                type="button"
                className={`diff-scope-option ${scope.kind === 'all' ? 'active' : ''}`}
                onClick={() => {
                  onPick({ kind: 'all' });
                  setOpen(false);
                }}
              >
                <span className="diff-scope-option-icon" aria-hidden="true">
                  <PullRequestIcon size={16} />
                </span>
                <span className="diff-scope-option-body">
                  <span className="diff-scope-option-title">{t('diffView.scopeAll')}</span>
                  <span className="diff-scope-option-sub">
                    {commits === null
                      ? t('diffView.scopeLoading')
                      : t('diffView.scopeCommitCount', { count: commits.length })}
                  </span>
                </span>
              </button>
            </li>
            {/* 每个 commit：标题（首行 message）+ 作者 / 短 SHA / 时间副行 */}
            {(commits ?? []).map((c) => {
              const subject = c.message.split('\n', 1)[0]!;
              const active = scope.kind === 'commit' && scope.sha === c.sha;
              return (
                <li key={c.sha}>
                  <button
                    type="button"
                    className={`diff-scope-option diff-scope-option-commit ${active ? 'active' : ''}`}
                    title={subject}
                    onClick={() => {
                      onPick({
                        kind: 'commit',
                        sha: c.sha,
                        parent: c.parents[0] ?? null,
                        abbreviatedSha: c.abbreviatedSha,
                        subject,
                      });
                      setOpen(false);
                    }}
                  >
                    <span className="diff-scope-option-icon" aria-hidden="true">
                      <CommitIcon size={16} />
                    </span>
                    <span className="diff-scope-option-body">
                      <span className="diff-scope-option-title">{subject}</span>
                      <span className="diff-scope-option-sub">
                        <Avatar
                          connectionId={connectionId}
                          slug={c.author.slug ?? c.author.name}
                          displayName={c.author.displayName}
                          avatarUrl={c.author.avatarUrl}
                          size={16}
                        />
                        <span className="diff-scope-author">{c.author.displayName}</span>
                        <code className="diff-scope-sha">{c.abbreviatedSha}</code>
                        <time className="diff-scope-time">
                          {formatRelativeTime(c.committedAt || c.authoredAt)}
                        </time>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
