import { useEffect, useState } from 'react';

/**
 * Delayed centered loading: does not appear within delayMs after mount, only shows the spinner past that.
 *
 * Heavy components (Monaco, ChatPane content, diff file tree) render an empty skeleton before async init
 * completes, and their ready times are staggered → multiple layout shifts (perceptible jitter). This component
 * covers the area during init; once ready, the caller unmounts it to reveal everything at once.
 *
 * **Delayed display** is key: switching PRs on desktop mostly hits the local cache within 150ms, and on the
 * fast path this component is mounted then quickly unmounted with the spinner never appearing → zero flicker;
 * only the truly slow cases (Monaco cold mount / large diff) fall through to the spinner. Reuses the existing
 * `.spinner` visual, introduces no new language.
 */
export function PaneLoading({
  delayMs = 150,
  label,
  overlay = false,
}: {
  delayMs?: number;
  label?: string;
  /** Absolutely positioned to fill the parent (parent needs position:relative), used to cover the Monaco editor. */
  overlay?: boolean;
}) {
  // delayMs<=0: definitely covering (e.g. Monaco overlay), show at frame 0, skip the delay.
  const [show, setShow] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);
  if (!show) return null;
  return (
    <div
      className={overlay ? 'pane-loading pane-loading-overlay' : 'pane-loading'}
      role="status"
      aria-live="polite"
    >
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : null}
    </div>
  );
}
