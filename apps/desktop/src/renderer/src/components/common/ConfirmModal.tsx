import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除等）时确认按钮显红色 */
  danger?: boolean;
  /** 从二层嵌套子模态弹出时置 true：用嵌套 backdrop（z-index 抬到 nested 层），叠在子模态之上 */
  nested?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认模态框，基于 Modal 壳。经 portal 渲染到 body 避开调用者层级（特别是 Monaco view
 * zone 内的 React tree，那一层 z-index 比 modal 低）。
 *
 * 键盘：Esc 取消，Enter 确认（焦点默认在取消按钮，避免误触）
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  nested = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('confirmModal.defaultTitle');
  const resolvedConfirmLabel = confirmLabel ?? t('common.confirm');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 忽略 OS 按键自动重复：若本模态由「按 Enter」打开（如 chat /merge 提交），按住 Enter 期间的
      // 重复 keydown 会在监听器挂载后触发 → 立即 onConfirm、模态一闪而过。仅响应全新按下（repeat=false）。
      if (e.repeat) return;
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

  return (
    <Modal
      portal
      nested={nested}
      size="confirm"
      onClose={onCancel}
      title={resolvedTitle}
      titleId="confirm-modal-title"
      bodyClassName="modal-confirm-body"
      footerClassName="modal-actions"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} autoFocus>
            {resolvedCancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {resolvedConfirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
