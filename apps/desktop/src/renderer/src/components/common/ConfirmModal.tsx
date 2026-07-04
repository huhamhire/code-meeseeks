import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';

interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirm button shows red for dangerous operations (delete, etc.) */
  danger?: boolean;
  /** Set true when popping from a second-level nested child modal: uses a nested backdrop (z-index raised to the nested layer), stacked above the child modal */
  nested?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic confirm modal, based on the Modal shell. Renders into body via portal to avoid the caller's layering (especially the React tree inside a Monaco view
 * zone, whose z-index is lower than the modal).
 *
 * Keyboard: Esc to cancel, Enter to confirm (focus defaults to the cancel button to avoid mis-clicks)
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
      // Ignore OS key auto-repeat: if this modal was opened by「pressing Enter」(e.g. chat /merge submit), the
      // repeated keydown while holding Enter fires after the listener mounts → immediate onConfirm, modal flashes past. Only respond to a fresh press (repeat=false).
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
