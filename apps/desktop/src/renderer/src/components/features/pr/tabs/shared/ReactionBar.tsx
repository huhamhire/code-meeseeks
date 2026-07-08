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

/** Estimated popup size (used for adaptive flip / viewport-clamp placeholder calculations; actual size is determined by content). */
const MENU_SIZE = {
  fixed: { w: 264, h: 48 },
  free: { w: 244, h: 232 },
} as const;

/** Compute the popup's fixed coordinates from the trigger button position + viewport space: flip up when there's insufficient space below and more room above; clamp horizontally to the viewport. */
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
 * Shared state + toggle logic for comment emoji reactions. Toggling writes remotely via `comments:toggleReaction`; on success main broadcasts
 * comments:changed → the comment list refetches and refreshes (no local optimistic state, consistent with edit/delete). Disabled during busy to avoid duplicate clicks.
 */
export function useReactions(
  prLocalId: string,
  comment: PrComment,
  readOnly: boolean,
): { reactions: PrReaction[]; busy: boolean; toggle: (emoji: string, add: boolean) => void } {
  const [busy, setBusy] = useState(false);
  const reactions = comment.reactions ?? [];
  // GitHub picks the issue / review reaction endpoint by kind; other platforms ignore it. anchor is the fallback (old
  // data has no kind). File-level comments are review comments too → use the 'inline' (review) reaction endpoint.
  const kind: 'summary' | 'inline' =
    (comment.kind ?? (comment.anchor ? 'inline' : 'summary')) === 'summary' ? 'summary' : 'inline';
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
          // Silent on failure: the list won't refresh a new reaction via comments:changed, state stays as-is
        })
        .finally(() => setBusy(false));
    },
    [busy, readOnly, prLocalId, comment.remoteId, kind],
  );
  return { reactions, busy, toggle };
}

/** Display bar for existing reactions: emoji + count, own reactions highlighted, click to toggle. Not rendered when there are no reactions. */
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
 * "Add reaction" button + popup picker. Placed inline in the comment action button row (after Reply/Edit). Click to toggle the popup, click outside the popup /
 * Esc to dismiss (non-modal). fixed mode (GitHub) lists a fixed 8; free mode (GitLab/Bitbucket) lists a curated set + search.
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

  // Position the popup by the trigger button; recompute on open and on scroll / resize (the popup uses portal + fixed, so it follows without being clipped).
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

  // Click outside the popup / trigger button, or Esc, dismisses (non-modal: no overlay, doesn't block other interactions).
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

/** free mode picker: search box + curated emoji grid (filter by keyword / shortcode). */
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
  // Empty query returns the curated default set; otherwise search the full gemoji vocabulary (truncated to 60).
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
