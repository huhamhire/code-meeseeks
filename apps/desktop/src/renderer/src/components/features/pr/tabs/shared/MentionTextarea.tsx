import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser } from '@meebox/shared';
import { ImageIcon } from '../../../../common';

/** 弹出候选最多展示条数（候选源本就是 PR 参与者的有界集合，再截断以免列表过长）。 */
const MAX_SUGGESTIONS = 8;

interface MentionMenu {
  /** `@` 之后已输入的查询串（不含 `@`）。 */
  query: string;
  /** `@` 在 value 中的下标（替换插入时的起点）。 */
  at: number;
  /** 过滤后的候选。 */
  items: PlatformUser[];
  /** 当前高亮项下标。 */
  index: number;
}

/**
 * 解析光标前文本里正在输入的 `@提及` token：返回 `@` 位置与查询串，否则 null。
 * 触发条件：`@` 紧跟在行首 / 空白 / 左括号之后，其后是「非空白非 @」串（用户名允许 . - _）。
 */
function parseMention(value: string, caret: number): { at: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { at: caret - query.length - 1, query };
}

/**
 * 评论编辑用 textarea，叠加 `@提及` 自动补全。候选由调用方传入（PR 参与者 + 评论作者等**已加载**的
 * 有界集合，不向远端枚举全员，见 docs/arch/01-platform/01-adapter）；输入 `@` 后按查询串就地过滤、↑↓ 选择、Enter/Tab 确认、
 * Esc 关闭。补全仅为便利——用户仍可自由手打任意 `@name`，平台据文本自行解析通知。
 *
 * 弹层打开时拦截 ↑↓/Enter/Tab/Esc 用于候选导航，其余按键（含 Cmd/Ctrl+Enter 发送、Esc 取消）冒泡给
 * 调用方的 onKeyDown；弹层关闭时所有按键都交给 onKeyDown。
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
   * 粘贴图片时的上传回调：上传成功返回可插入的 markdown（否则 null）。提供时启用图片粘贴上传
   * （平台 commentAttachments 能力为真才由调用方传入）。上传期间禁用输入，避免 value 漂移。
   */
  onUpload?: (file: File) => Promise<string | null>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  /**
   * 可选：把内部 textarea 元素回传给调用方 ref（与组件内部 ref 并存）。供调用方做外部 focus /
   * 焦点判定（如 DraftZone 进入编辑态聚焦、Esc 命中判定）。不传则仅组件内部使用。
   */
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<MentionMenu | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 候选去重（按 name），保序：调用方可能混入重复参与者 / 评论作者。
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
    // 插入后把光标放到补全文本之后
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

  // 上传一张图片并把返回的 markdown 插入当前光标处（无焦点时插到末尾）。粘贴 / 点附件按钮共用。
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
        // 上传失败（平台拒绝 / 网络等）：就地提示，不让 rejection 逃逸成未处理异常。
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
    e.target.value = ''; // 复位：同一文件可再次选取触发 change
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
                // mousedown 而非 click：抢在 textarea blur（关闭弹层）之前选中
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
