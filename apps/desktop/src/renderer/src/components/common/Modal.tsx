import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CSSProperties, ReactNode } from 'react';
import { CloseIcon } from './icons';

type ModalSize = 'md' | 'sm' | 'confirm';

const SIZE_CLASS: Record<ModalSize, string> = {
  md: 'modal',
  sm: 'modal modal-sm',
  confirm: 'modal modal-confirm',
};

interface ModalProps {
  onClose: () => void;
  /** 弹窗尺寸 → 容器类名：md=modal · sm=modal-sm · confirm=modal-confirm */
  size?: ModalSize;
  /** 二层嵌套模态：加 modal-backdrop-nested，背景点击 stopPropagation 防冒泡关掉外层模态 */
  nested?: boolean;
  /** 经 createPortal 渲染到 body：避开调用者所在层级（如 Monaco view zone 内 z-index 偏低） */
  portal?: boolean;
  /** 点背景是否关闭（默认 true） */
  closeOnBackdrop?: boolean;
  /** 标题（不传则不渲染 header） */
  title?: ReactNode;
  /** 标题元素 id，配合 aria-labelledby */
  titleId?: string;
  /** header 右侧关闭按钮样式：图标按钮 / 文案按钮（不传则无） */
  headerClose?: 'icon' | 'text';
  /** modal-body 追加类名（如 confirm-body） */
  bodyClassName?: string;
  /** 底部 footer 区内容（作为 modal-body 的兄弟渲染）；不传则无 footer 区 */
  footer?: ReactNode;
  /** footer 容器类名（默认 modal-footer-bar；确认框用 modal-actions） */
  footerClassName?: string;
  /** 容器内联样式（个别弹窗自定宽度用） */
  style?: CSSProperties;
  ariaLabel?: string;
  ariaLabelledby?: string;
  children: ReactNode;
}

/**
 * 通用模态壳：统一 backdrop（点外关闭 + 嵌套防冒泡）、dialog 容器、可选 header（标题 + 关闭键）、
 * modal-body 包裹、可选 footer 区。键盘交互（Esc / Enter）由各调用方按需自管——壳只负责结构与样式语言。
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
      // 背景点击只关本层：stopPropagation 防止冒泡到外层模态 backdrop（嵌套时不拦会连外层一起关）。
      // 顶层用法下 stopPropagation 无副作用。
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
        <div className={bodyClassName ? `modal-body ${bodyClassName}` : 'modal-body'}>
          {children}
        </div>
        {footer !== undefined && <div className={footerClassName}>{footer}</div>}
      </div>
    </div>
  );
  return portal ? createPortal(tree, document.body) : tree;
}
