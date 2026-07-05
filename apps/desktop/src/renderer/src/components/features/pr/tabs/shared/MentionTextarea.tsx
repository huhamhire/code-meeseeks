import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser } from '@meebox/shared';
import { ImageIcon } from '../../../../common';

/** Max number of suggestions shown in the popup (the source is already a bounded set of PR participants; truncate further to keep the list from growing too long). */
const MAX_SUGGESTIONS = 8;

interface MentionMenu {
  /** Query string typed after `@` (excluding `@`). */
  query: string;
  /** Index of `@` in value (start point for replacement insertion). */
  at: number;
  /** Filtered suggestions. */
  items: PlatformUser[];
  /** Index of the currently highlighted item. */
  index: number;
}

/**
 * Parse the `@mention` token being typed in the text before the cursor: return the `@` position and query string, otherwise null.
 * Trigger condition: `@` immediately follows the line start / whitespace / an opening paren, followed by a "non-whitespace non-@" string (usernames allow . - _).
 */
function parseMention(value: string, caret: number): { at: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { at: caret - query.length - 1, query };
}

/**
 * Comment-editing textarea overlaid with `@mention` autocomplete. Suggestions are passed in by the caller (a bounded set of **already loaded**
 * PR participants + comment authors etc., not an enumeration of all remote members, see docs/arch/01-platform/01-adapter); after typing `@` filter in place by the query string, ↑↓ to select, Enter/Tab to confirm,
 * Esc to close. Autocomplete is only a convenience — users can still freely type any `@name` by hand, and the platform parses notifications from the text itself.
 *
 * While the popup is open, ↑↓/Enter/Tab/Esc are intercepted for suggestion navigation; other keys (including Cmd/Ctrl+Enter to send, Esc to cancel) bubble up to
 * the caller's onKeyDown; while the popup is closed all keys go to onKeyDown.
 */
export function MentionTextarea({
  value,
  onChange,
  candidates,
  onKeyDown,
  onUpload,
  placeholder,
  rows = 3,
  disabled = false,
  className,
  autoFocus = false,
  ariaLabel,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  candidates: PlatformUser[];
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Upload callback for pasted images: returns insertable markdown on success (otherwise null). When provided, enables image paste upload
   * (the caller only passes it when the platform's commentAttachments capability is true). Input is disabled during upload to avoid value drift.
   */
  onUpload?: (file: File) => Promise<string | null>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  /**
   * Optional: pass the internal textarea element back to the caller's ref (coexists with the component's internal ref). Lets the caller do external focus /
   * focus checks (e.g. DraftZone focusing on entering edit mode, Esc hit testing). If omitted, used only internally by the component.
   */
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<MentionMenu | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Dedupe suggestions (by name), preserving order: the caller may mix in duplicate participants / comment authors.
  const pool = useMemo(() => {
    const seen = new Set<string>();
    const out: PlatformUser[] = [];
    for (const u of candidates) {
      if (!u.name || seen.has(u.name)) continue;
      seen.add(u.name);
      out.push(u);
    }
    return out;
  }, [candidates]);

  const refresh = (el: HTMLTextAreaElement): void => {
    if (pool.length === 0) {
      setMenu(null);
      return;
    }
    const ctx = parseMention(el.value, el.selectionStart ?? el.value.length);
    if (!ctx) {
      setMenu(null);
      return;
    }
    const q = ctx.query.toLowerCase();
    const items = pool
      .filter(
        (u) =>
          q === '' ||
          u.name.toLowerCase().includes(q) ||
          u.displayName.toLowerCase().includes(q),
      )
      .slice(0, MAX_SUGGESTIONS);
    setMenu(items.length > 0 ? { query: ctx.query, at: ctx.at, items, index: 0 } : null);
  };

  const select = (user: PlatformUser): void => {
    if (!menu) return;
    const end = menu.at + 1 + menu.query.length;
    const insert = `@${user.name} `;
    const next = value.slice(0, menu.at) + insert + value.slice(end);
    onChange(next);
    setMenu(null);
    // After insertion, place the cursor after the completed text
    const caret = menu.at + insert.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (menu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenu({ ...menu, index: (menu.index + 1) % menu.items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenu({ ...menu, index: (menu.index - 1 + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        select(menu.items[menu.index]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  // Upload one image and insert the returned markdown at the current cursor (append to end when unfocused). Shared by paste / clicking the attach button.
  const uploadAndInsert = (file: File): void => {
    if (!onUpload || uploading) return;
    const at = ref.current?.selectionStart ?? value.length;
    setUploading(true);
    setUploadError(null);
    void onUpload(file)
      .then((md) => {
        if (!md) return;
        const next = value.slice(0, at) + md + value.slice(at);
        onChange(next);
        const caret = at + md.length;
        requestAnimationFrame(() => {
          const el = ref.current;
          if (el) {
            el.focus();
            el.setSelectionRange(caret, caret);
          }
        });
      })
      .catch((e: unknown) => {
        // Upload failed (platform rejection / network etc.): show inline, don't let the rejection escape as an unhandled exception.
        setUploadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setUploading(false));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onUpload || uploading) return;
    const item = Array.from(e.clipboardData.items).find(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    );
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    uploadAndInsert(file);
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) uploadAndInsert(file);
    e.target.value = ''; // Reset: allow the same file to be selected again to trigger change
  };

  return (
    <div className="mention-textarea-wrap">
      <textarea
        ref={(el) => {
          ref.current = el;
          if (textareaRef) textareaRef.current = el;
          if (el && autoFocus && document.activeElement !== el && value === '') el.focus();
        }}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target);
        }}
        onKeyUp={(e) => refresh(e.currentTarget)}
        onClick={(e) => refresh(e.currentTarget)}
        onBlur={() => setMenu(null)}
        onKeyDown={handleKeyDown}
        onPaste={onUpload ? handlePaste : undefined}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled || uploading}
        aria-label={ariaLabel}
      />
      {onUpload && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={pickFile}
          />
          <button
            type="button"
            className="mention-attach"
            disabled={disabled || uploading}
            onClick={() => fileInputRef.current?.click()}
            title={t('attachments.attachTitle')}
            aria-label={t('attachments.attachTitle')}
          >
            <ImageIcon size={15} />
          </button>
        </>
      )}
      {uploading && <div className="mention-upload-status muted">{t('attachments.uploading')}</div>}
      {uploadError && (
        <div className="mention-upload-error" role="alert">
          {t('attachments.uploadFailed', { msg: uploadError })}
          <button
            type="button"
            className="mention-upload-error-dismiss"
            onClick={() => setUploadError(null)}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            ✕
          </button>
        </div>
      )}
      {menu && (
        <ul className="mention-menu" role="listbox">
          {menu.items.map((u, i) => (
            <li key={u.name}>
              <button
                type="button"
                role="option"
                aria-selected={i === menu.index}
                className={`mention-option${i === menu.index ? ' mention-option-active' : ''}`}
                // mousedown rather than click: select before the textarea blur (which closes the popup)
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(u);
                }}
                onMouseEnter={() => setMenu({ ...menu, index: i })}
              >
                <span className="mention-option-name">@{u.name}</span>
                {u.displayName !== u.name && (
                  <span className="mention-option-display muted">{u.displayName}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
