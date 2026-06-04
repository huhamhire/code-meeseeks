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
