import type { ReactNode } from 'react';

type ChipTone = 'ok' | 'err';

interface StatusChipProps {
  /** Render element: defaults to button when onClick is present, otherwise span */
  as?: 'span' | 'button';
  /** Semantic tone → statusbar-chip-ok / statusbar-chip-err */
  tone?: ChipTone;
  /** Appended dedicated class name (e.g. statusbar-pragent-chip / statusbar-llm-chip) */
  className?: string;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

/**
 * Generic status-bar chip shell: unified `statusbar-chip` base class + optional semantic tone (ok/err), rendered as
 * button / span depending on whether it is clickable, passing through title / aria / disabled. Each chip's internal
 * structure (icon / text / dropdown) is managed as children, with dedicated styles appended via className.
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
