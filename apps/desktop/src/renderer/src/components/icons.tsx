// 跨组件复用的内联 SVG 图标。统一 currentColor 描边，跟随主题色 / 父元素文字色，
// 离线无网络依赖。需要不同尺寸时传 size（viewBox 固定 16，缩放即可）。

interface IconProps {
  size?: number;
  /** 个别图标需要外部 class（如 ChevronIcon 的 tree-chevron 旋转动画）；其余忽略。 */
  className?: string;
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

/** 纸飞机（横向，Lucide send-horizontal 风格）：发送 / 提交按钮用 */
export function SendIcon({ size = 14 }: IconProps) {
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
      <path d="M2 2 L14 8 L2 14 L5 8 Z" />
      <path d="M5 8 L14 8" />
    </svg>
  );
}

/** 实心圆角方块：停止 / 取消（媒体停止键视觉惯例）。fill 版，无描边 */
export function StopIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

/** 圆圈内 `?`：/ask 用户提问 chip 前缀（跟答案区分） */
export function QuestionIcon({ size = 14 }: IconProps) {
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
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6 6.2a2 2 0 1 1 2.7 1.9c-.6.2-.7.7-.7 1.2v.4" />
      <line x1="8" y1="12" x2="8" y2="12.2" />
    </svg>
  );
}

/** 循环箭头（refresh-cw 风格）：重试动作，chip 内嵌小尺寸。与 SyncIcon（双箭头）区分语义 */
export function RetryIcon({ size = 14 }: IconProps) {
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
      <path d="M13.5 3.5v3.5h-3.5" />
      <path d="M13 7.5A5 5 0 1 0 11.5 11.5" />
    </svg>
  );
}

/** 对话气泡：chat 面板触发 / 空态。large 场景传 size（如 28） */
export function ChatIcon({ size = 14 }: IconProps) {
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
      <path d="M2.5 3.5h11A1 1 0 0 1 14.5 4.5v6A1 1 0 0 1 13.5 11.5H6L3 13.5V11.5H2.5A1 1 0 0 1 1.5 10.5v-6A1 1 0 0 1 2.5 3.5z" />
    </svg>
  );
}

/** 文件树（三横线带项目符号）：DiffView 退出搜索 / tree 模式指示 */
export function FileTreeIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="6" y1="8" x2="13" y2="8" />
      <line x1="6" y1="12" x2="13" y2="12" />
      <circle cx="3" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 放大镜：进入搜索模式 */
export function SearchIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="13.5" y2="13.5" />
    </svg>
  );
}

/** 右向折角箭头：树节点展开 / 折叠。className 供旋转动画（FileTree 传 tree-chevron） */
export function ChevronIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5 3 11 8 5 13" />
    </svg>
  );
}

/** 地球经纬网格：在远端浏览器打开 */
export function GlobeIcon({ size = 14 }: IconProps) {
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
      <circle cx="8" cy="8" r="6.5" />
      <ellipse cx="8" cy="8" rx="3" ry="6.5" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

/** 头肩剪影：作者行前缀 / blame 视图 / 账户指示（统一的「人」图标，合并原 PersonIcon、BlameIcon、UserIcon） */
export function PersonIcon({ size = 12 }: IconProps) {
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
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  );
}

/** 空白字符可视化（·→·）：显示 space / tab */
export function WhitespaceIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <path d="M6 8 h6 m-2 -2 l2 2 l-2 2" />
    </svg>
  );
}

/** 圆圈内对勾：审批通过 */
export function ApproveIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.3l2.2 2.2L11 6.5" />
    </svg>
  );
}

/** 圆圈内感叹号：需要修改 */
export function NeedsWorkIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4.2" />
      <circle cx="8" cy="11.3" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 双星火花（sparkles）：AI 自动评审动作。两颗四角星，区别于工具命令的 `/` 触发器 */
export function AutoReviewIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.6 2l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z" />
      <path d="M4.4 9.1l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </svg>
  );
}

/** 双向循环箭头（Lucide refresh-cw-2 风格）：同步状态。与 RetryIcon（单箭头，重试动作）区分语义 */
export function SyncIcon({ size = 12 }: IconProps) {
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
      <path d="M3 6.5a5 5 0 0 1 9-1.5" />
      <polyline points="12 2 12 5 9 5" />
      <path d="M13 9.5a5 5 0 0 1-9 1.5" />
      <polyline points="4 14 4 11 7 11" />
    </svg>
  );
}

/** 齿轮（Lucide settings，viewBox 24）：设置按钮 */
export function SettingsIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * 面板开关：矩形 + 分隔细条。`side` 决定细条 / 收起态实心块在左（侧栏）还是右（chat 面板）——
 * 原 SidebarIcon 与镜像版 ChatPanelIcon 合并为一个参数化图标。collapsed 时细条侧变实心。
 */
export function PanelToggleIcon({
  side,
  collapsed,
  size = 14,
}: IconProps & { side: 'left' | 'right'; collapsed: boolean }) {
  const dividerX = side === 'left' ? 6.5 : 9.5;
  const fillX = side === 'left' ? 2 : 9.5;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1={dividerX} y1="3" x2={dividerX} y2="13" />
      {collapsed && <rect x={fillX} y="3" width="4.5" height="10" fill="currentColor" />}
    </svg>
  );
}

/**
 * 完成徽章：大圆环 + 对勾。onboarding 完成步使用。path 带 `onboarding-check-path` class
 * 供 CSS 描边动画（stroke-dashoffset）。默认 76px（viewBox 52）。
 */
export function SuccessBadgeIcon({ size = 76 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" aria-hidden="true">
      <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" opacity="0.35" />
      <path
        className="onboarding-check-path"
        d="M15 27l7.5 7.5L38 18.5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** GitHub Octocat 标记（随文字色，用于「关于」链接的 GitHub / Star 入口）。 */
export function GitHubMarkIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.52.1.71-.23.71-.5l-.01-1.77c-2.92.64-3.54-1.25-3.54-1.25-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.06.07 1.61 1.09 1.61 1.09.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.66-1.4-2.33-.27-4.78-1.17-4.78-5.18 0-1.15.41-2.08 1.08-2.82-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.07a10 10 0 0 1 5.24 0c2-1.35 2.88-1.07 2.88-1.07.57 1.45.21 2.52.1 2.79.67.74 1.08 1.67 1.08 2.82 0 4.02-2.46 4.9-4.8 5.16.38.33.71.97.71 1.96l-.01 2.9c0 .28.19.61.72.5A10.5 10.5 0 0 0 12 1.5z"
      />
    </svg>
  );
}

/** GitHub issue 字形：空心圆 + 实心圆点。用于「提交反馈 / Issue」入口。 */
export function IssueIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** 标签 / 发布字形：带孔的 tag。用于「发布记录」入口。 */
export function TagIcon({ size = 14 }: IconProps) {
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
      <path d="M7.6 2.2H3.2a1 1 0 0 0-1 1v4.4a1 1 0 0 0 .3.7l6 6a1 1 0 0 0 1.4 0l4.1-4.1a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-.4-.3 1 1 0 0 0-.4-.6z" />
      <circle cx="5" cy="5" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}
