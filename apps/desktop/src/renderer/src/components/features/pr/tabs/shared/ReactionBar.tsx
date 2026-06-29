import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  REACTION_PICKER,
  searchReactionEmojis,
  type PrComment,
  type PrReaction,
} from '@meebox/shared';
import { SmilePlusIcon } from '../../../../common';
import { invoke } from '../../../../../api';

/** 弹层估算尺寸（用于自适应翻转 / 视口夹取的占位计算；实际尺寸由内容决定）。 */
const MENU_SIZE = {
  fixed: { w: 264, h: 48 },
  free: { w: 244, h: 232 },
} as const;

/** 据触发按钮位置 + 视口空间算弹层 fixed 坐标：下方空间不足且上方更宽裕则上翻；水平按视口夹取。 */
function computeMenuPos(rect: DOMRect, mode: 'fixed' | 'free'): { top: number; left: number } {
  const margin = 6;
  const { w, h } = MENU_SIZE[mode];
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUp = spaceBelow < h + margin && rect.top > spaceBelow;
  const top = openUp ? Math.max(margin, rect.top - h - margin) : rect.bottom + margin;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - w - margin));
  return { top, left };
}

/**
 * 评论 emoji 反应的共享状态 + 切换逻辑。切换经 `comments:toggleReaction` 写远端，成功后 main 广播
 * comments:changed → 评论列表重拉刷新（不维护本地乐观态，与编辑/删除一致）。busy 期间禁用避免重复点击。
 */
export function useReactions(
  prLocalId: string,
  comment: PrComment,
  readOnly: boolean,
): { reactions: PrReaction[]; busy: boolean; toggle: (emoji: string, add: boolean) => void } {
  const [busy, setBusy] = useState(false);
  const reactions = comment.reactions ?? [];
  // GitHub 据 kind 选 issue / review 反应端点；其余平台忽略。anchor 兜底（旧数据无 kind）。
  const kind: 'summary' | 'inline' = comment.kind ?? (comment.anchor ? 'inline' : 'summary');
  const toggle = useCallback(
    (emoji: string, add: boolean): void => {
      if (busy || readOnly) return;
      setBusy(true);
      void invoke('comments:toggleReaction', {
        localId: prLocalId,
        commentId: comment.remoteId,
        kind,
        emoji,
        add,
      })
        .catch(() => {
          // 失败静默：列表不会因 comments:changed 刷新出新反应，状态保持原样
        })
        .finally(() => setBusy(false));
    },
    [busy, readOnly, prLocalId, comment.remoteId, kind],
  );
  return { reactions, busy, toggle };
}

/** 已有反应的展示条：emoji + 计数，本人反应高亮，点击切换。无反应则不渲染。 */
export function ReactionChips({
  reactions,
  busy,
  readOnly = false,
  onToggle,
}: {
  reactions: PrReaction[];
  busy: boolean;
  readOnly?: boolean;
  onToggle: (emoji: string, add: boolean) => void;
}) {
  const { t } = useTranslation();
  if (reactions.length === 0) return null;
  return (
    <div className="pr-reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`pr-reaction${r.mine ? ' pr-reaction-mine' : ''}`}
          disabled={readOnly || busy}
          onClick={() => onToggle(r.emoji, !r.mine)}
          title={t(r.mine ? 'reactions.removeTitle' : 'reactions.addTitle', { emoji: r.emoji })}
        >
          <span className="pr-reaction-emoji">{r.emoji}</span>
          <span className="pr-reaction-count">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 「加反应」按钮 + 弹出选择器。放在评论操作按钮行内（Reply/Edit 之后）。点击切换弹层，点击弹层外部 /
 * Esc 收起（非模态）。fixed 模式（GitHub）列固定 8 种；free 模式（GitLab/Bitbucket）列精选集 + 搜索。
 */
export function ReactionAddButton({
  reactions,
  busy,
  mode,
  onToggle,
}: {
  reactions: PrReaction[];
  busy: boolean;
  mode: 'fixed' | 'free';
  onToggle: (emoji: string, add: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 据触发按钮位置定位弹层；开启时及滚动 / 缩放时重算（弹层走 portal + fixed，故跟随而不被裁切）。
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const el = triggerRef.current;
      if (el) setPos(computeMenuPos(el.getBoundingClientRect(), mode));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, mode]);

  // 点击弹层 / 触发按钮以外 / Esc 收起（非模态：不加遮罩、不拦其它交互）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const mineOf = (emoji: string): boolean => reactions.find((r) => r.emoji === emoji)?.mine ?? false;
  const pick = (emoji: string): void => {
    onToggle(emoji, !mineOf(emoji));
    setOpen(false);
  };

  return (
    <div className="pr-reaction-add-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="pr-reaction-add"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        title={t('reactions.pickTitle')}
        aria-label={t('reactions.pickTitle')}
      >
        <SmilePlusIcon size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="pr-reaction-portal"
            style={{ top: pos.top, left: pos.left }}
          >
            {mode === 'free' ? (
              <FreeReactionPicker busy={busy} mineOf={mineOf} onPick={pick} />
            ) : (
              <div className="pr-reaction-picker" role="menu">
                {REACTION_PICKER.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`pr-reaction-pick${mineOf(emoji) ? ' pr-reaction-mine' : ''}`}
                    disabled={busy}
                    onClick={() => pick(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** free 模式选择器：搜索框 + 精选 emoji 网格（按关键词 / shortcode 过滤）。 */
function FreeReactionPicker({
  busy,
  mineOf,
  onPick,
}: {
  busy: boolean;
  mineOf: (emoji: string) => boolean;
  onPick: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  // 空查询回精选默认集；否则在全量 gemoji 词表搜索（截断 60）。
  const items = searchReactionEmojis(q);
  return (
    <div className="pr-reaction-picker pr-reaction-picker-free" role="menu">
      <input
        type="text"
        className="pr-reaction-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('reactions.searchPlaceholder')}
        aria-label={t('reactions.searchPlaceholder')}
        autoFocus
      />
      {items.length > 0 ? (
        <div className="pr-reaction-grid">
          {items.map((e) => (
            <button
              key={e.code}
              type="button"
              className={`pr-reaction-pick${mineOf(e.emoji) ? ' pr-reaction-mine' : ''}`}
              disabled={busy}
              onClick={() => onPick(e.emoji)}
              title={e.code}
            >
              {e.emoji}
            </button>
          ))}
        </div>
      ) : (
        <div className="pr-reaction-empty muted">{t('reactions.noMatch')}</div>
      )}
    </div>
  );
}
