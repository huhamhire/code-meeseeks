import { Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Whether an error is a dynamic-import failure — the chunk behind a `lazy()` could not be fetched.
 *
 * Worth distinguishing because the remedy is the opposite of the usual one: the page is holding a hashed chunk URL that
 * no longer exists on disk (the app was rebuilt or updated while this window stayed open), so **retrying re-requests the
 * same dead URL and fails again**. Only a reload — which re-reads the entry and picks up current hashes — recovers.
 *
 * The message differs per engine, hence matching several forms rather than one.
 */
export function isChunkLoadError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('failed to fetch dynamically imported module') || // Chromium (Electron)
    msg.includes('error loading dynamically imported module') || // Firefox
    msg.includes('importing a module script failed') || // Safari
    msg.includes('unable to preload') // Vite's preload helper
  );
}

/**
 * Suspense + an error boundary around a `lazy()` subtree.
 *
 * `Suspense` alone only covers the *pending* half of a lazy import: if the chunk fails to load, the promise rejects and
 * the error propagates to the nearest boundary. With no boundary in between it reaches the root one and takes the whole
 * app down — a Monaco snippet failing to load should not cost the user the comment thread around it. So each lazy
 * subtree gets its own boundary, and the failure stays inside the pane that could not load.
 */
export function LazyBoundary({
  label,
  loading,
  children,
}: {
  /** Names the failing region in logs (see ErrorBoundary). */
  label: string;
  /** Rendered while the chunk is in flight. */
  loading: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ErrorBoundary
      label={label}
      fallback={(err, reset) => (
        <div className="lazy-boundary-error">
          <p>{t('lazyLoad.failed')}</p>
          <p className="muted">
            {isChunkLoadError(err) ? t('lazyLoad.staleHint') : t('lazyLoad.genericHint')}
          </p>
          <div className="lazy-boundary-actions">
            {/* Retry is offered only when it can actually work: for a stale chunk it would re-request the same dead
                URL, so that case leads with reload instead. */}
            {!isChunkLoadError(err) && (
              <button type="button" className="btn btn-sm" onClick={reset}>
                {t('crash.retry')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => window.location.reload()}
            >
              {t('crash.reload')}
            </button>
          </div>
        </div>
      )}
    >
      <Suspense fallback={loading}>{children}</Suspense>
    </ErrorBoundary>
  );
}
