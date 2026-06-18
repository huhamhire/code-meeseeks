import type { ReactNode } from 'react';

type ChipTone = 'ok' | 'err';

interface StatusChipProps {
  /** 渲染元素：默认有 onClick 时为 button、否则 span */
  as?: 'span' | 'button';
  /** 语义色调 → statusbar-chip-ok / statusbar-chip-err */
  tone?: ChipTone;
  /** 追加的专属类名（如 statusbar-pragent-chip / statusbar-llm-chip） */
  className?: string;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/**
 * 状态栏 chip 通用壳：统一 `statusbar-chip` 基类 + 可选语义色调（ok/err），按是否可点
 * 渲染为 button / span，并透传 title / aria / disabled。各 chip 内部结构（图标 / 文案 /
 * 下拉）作为 children 自管，专属样式经 className 追加。
 */
export function StatusChip({
  as,
  tone,
  className,
  title,
  ariaLabel,
  ariaPressed,
  disabled,
  onClick,
  children,
}: StatusChipProps) {
  const cls = ['statusbar-chip', tone && `statusbar-chip-${tone}`, className]
    .filter(Boolean)
    .join(' ');
  const element = as ?? (onClick ? 'button' : 'span');
  if (element === 'button') {
    return (
      <button
        type="button"
        className={cls}
        title={title}
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={cls} title={title} aria-label={ariaLabel}>
      {children}
    </span>
  );
}
