import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除等）时确认按钮显红色 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认模态框，跟 SettingsModal 共用 .modal-backdrop / .modal 视觉语言。
 * 用 createPortal 渲染到 document.body 避开调用者所在层级（特别是 Monaco view
 * zone 内的 React tree，那一层 z-index 比 modal 低）。
 *
 * 键盘：Esc 取消，Enter 确认（焦点默认在取消按钮，避免误触）
 */
export function ConfirmModal({
  title = '请确认',
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="modal modal-confirm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <div className="modal-header">
          <h3 id="confirm-modal-title">{title}</h3>
        </div>
        <div className="modal-body modal-confirm-body">
          <p>{message}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
