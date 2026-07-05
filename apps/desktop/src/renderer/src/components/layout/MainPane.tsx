import type { ReactNode } from 'react';

/**
 * Main content area (thin layout shell): provides only the semantic `<main>` slot; content is
 * decided by the upper layer (App) per the current business.
 * Domain-agnostic (unaware of PRs etc.), easing future non-PR main-area business—just drop another
 * pane into this slot.
 */
export function MainPane({ children }: { children: ReactNode }) {
  return <main className="main">{children}</main>;
}
