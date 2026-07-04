import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CSSProperties, ReactNode } from 'react';
import { CloseIcon } from './icons';

type ModalSize = 'lg' | 'md' | 'sm' | 'confirm';

const SIZE_CLASS: Record<ModalSize, string> = {
  lg: 'modal modal-lg',
  md: 'modal',
  sm: 'modal modal-sm',
  confirm: 'modal modal-confirm',
};

interface ModalProps {
  onClose: () => void;
  /** Modal size → container class name: md=modal · sm=modal-sm · confirm=modal-confirm */
  size?: ModalSize;
  /** Second-level nested modal: adds modal-backdrop-nested, backdrop-click stopPropagation prevents bubbling that would close the outer modal */
  nested?: boolean;
  /** Rendered to body via createPortal: avoids the caller's stacking context (e.g. low z-index inside a Monaco view zone) */
  portal?: boolean;
  /** Whether clicking the backdrop closes (default true) */
  closeOnBackdrop?: boolean;
  /** Title (header is not rendered if omitted) */
  title?: ReactNode;
  /** Title element id, paired with aria-labelledby */
  titleId?: string;
  /** Close button style on the right of the header: icon button / text button (none if omitted) */
  headerClose?: 'icon' | 'text';
  /** Custom actions on the right of the header, left of the close button (e.g. an "open directory" button); right-aligned in the same group as the close button. */
  headerActions?: ReactNode;
  /** Extra class name appended to modal-body (e.g. confirm-body) */
  bodyClassName?: string;
  /** Bottom footer area content (rendered as a sibling of modal-body); no footer area if omitted */
  footer?: ReactNode;
  /** Footer container class name (default modal-footer-bar; confirm dialogs use modal-actions) */
  footerClassName?: string;
  /** Container inline style (used by individual modals with custom widths) */
  style?: CSSProperties;
  ariaLabel?: string;
  ariaLabelledby?: string;
  children: ReactNode;
}

/**
 * Generic modal shell: unified backdrop (click-outside to close + nested bubbling guard), dialog container, optional header (title + close button),
 * modal-body wrapper, optional footer area. Keyboard interaction (Esc / Enter) is managed by each caller as needed — the shell only handles structure and the styling language.
 */
export function Modal({
  onClose,
  size = 'md',
  nested = false,
  portal = false,
  closeOnBackdrop = true,
  title,
  titleId,
  headerClose,
  headerActions,
  bodyClassName,
  footer,
  footerClassName = 'modal-footer-bar',
  style,
  ariaLabel,
  ariaLabelledby,
  children,
}: ModalProps) {
  const { t } = useTranslation();
  const tree = (
    <div
      className={`modal-backdrop${nested ? ' modal-backdrop-nested' : ''}`}
      // Backdrop click closes only this layer: stopPropagation prevents bubbling to the outer modal backdrop (without it, nesting would close the outer one too).
      // In top-level usage stopPropagation has no side effect.
      onClick={(e) => {
        e.stopPropagation();
        if (closeOnBackdrop) onClose();
      }}
      role="presentation"
    >
      <div
        className={SIZE_CLASS[size]}
        style={style}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby ?? titleId}
      >
        {title !== undefined && (
          <div className="modal-header">
            <h3 id={titleId}>{title}</h3>
            {(headerActions !== undefined || headerClose) && (
              <div className="modal-header-right">
                {headerActions}
                {headerClose === 'icon' && (
                  <button
                    className="icon-btn modal-close"
                    type="button"
                    onClick={onClose}
                    aria-label={t('common.close')}
                    title={t('common.close')}
                  >
                    <CloseIcon />
                  </button>
                )}
                {headerClose === 'text' && (
                  <button className="btn" type="button" onClick={onClose}>
                    {t('common.close')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className={bodyClassName ? `modal-body ${bodyClassName}` : 'modal-body'}>
          {children}
        </div>
        {footer !== undefined && <div className={footerClassName}>{footer}</div>}
      </div>
    </div>
  );
  return portal ? createPortal(tree, document.body) : tree;
}
