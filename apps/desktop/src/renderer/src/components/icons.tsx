// 跨组件复用的内联 SVG 图标。统一 currentColor 描边，跟随主题色 / 父元素文字色，
// 离线无网络依赖。需要不同尺寸时传 size（viewBox 固定 16，缩放即可）。

interface IconProps {
  size?: number;
}

/**
 * git pull-request / 分支合并字形：两条分支汇入 + 指向合并点的箭头。
 * 既用于 PR 列表分支行前缀，也用于"合并"按钮 / 可合并 chip —— 同一语义同一图形。
 */
export function PullRequestIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <line x1="4" y1="5.6" x2="4" y2="10.4" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 10.4 V7 a3 3 0 0 0 -3 -3 H6.5" />
      <path d="M8 2 L6 4 L8 6" />
    </svg>
  );
}

/** 关闭叉号：模态框右上角通用关闭按钮用，图标免国际化。 */
export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/** 文件夹：选择目录按钮用 */
export function FolderIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 l1.5 1.5 H13.5 A1 1 0 0 1 14.5 6 V11.5 A1 1 0 0 1 13.5 12.5 H2.5 A1 1 0 0 1 1.5 11.5 Z" />
    </svg>
  );
}

/** 铅笔：编辑按钮用 */
export function PencilIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 2.5 13.5 5 5.5 13 2.5 13.5 3 10.5 Z" />
      <line x1="9.5" y1="4" x2="12" y2="6.5" />
    </svg>
  );
}

/** 睁眼：密钥/令牌「显示」状态用 */
export function EyeIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.8 8C3.2 4.9 12.8 4.9 14.2 8 12.8 11.1 3.2 11.1 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

/** 闭眼（带斜杠）：密钥/令牌「隐藏」状态用 */
export function EyeOffIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.8 8C3.2 4.9 12.8 4.9 14.2 8 12.8 11.1 3.2 11.1 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
      <line x1="3" y1="13" x2="13" y2="3" />
    </svg>
  );
}

/** 垃圾桶：删除按钮用 */
export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <path d="M3.5 4 4 13 A1 1 0 0 0 5 14 H11 A1 1 0 0 0 12 13 L12.5 4" />
      <path d="M6 4 V2.5 A0.5 0.5 0 0 1 6.5 2 H9.5 A0.5 0.5 0 0 1 10 2.5 V4" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="11.5" />
      <line x1="9.5" y1="6.5" x2="9.5" y2="11.5" />
    </svg>
  );
}
