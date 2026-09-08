import { useTranslation } from 'react-i18next';
import { isChunkLoadError } from './LazyBoundary';

/**
 * Full-window fallback for a crash in the app's root subtree.
 *
 * Without a boundary at the root, any error thrown while rendering unmounts the whole tree and leaves an empty `#root`
 * — which reads as a permanently black window, with no way back short of restarting the app. This screen is what the
 * user gets instead: what broke, and a way out.
 *
 * The way out depends on the failure. `onRetry` re-renders the subtree, which is enough when the crash came from
 * transient state (a stale record read during an in-flight update). A **stale chunk** is the exception: the page holds
 * a hashed module URL that no longer exists (the app was rebuilt or updated while this window stayed open), so
 * re-rendering re-requests the same dead URL and fails identically — only a reload recovers. Offering "retry" there
 * would be offering a button that cannot work, so that case leads with reload and explains why.
 */
export function AppCrashScreen({ err, onRetry }: { err: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  const stale = isChunkLoadError(err);
  return (
    <div className="app-crash" role="alert">
      <div className="app-crash-card">
        <h1 className="app-crash-title">{stale ? t('crash.staleTitle') : t('crash.title')}</h1>
        <p className="app-crash-hint">{stale ? t('crash.staleHint') : t('crash.hint')}</p>
        <pre className="app-crash-detail">{err.message || String(err)}</pre>
        <div className="app-crash-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            {t('crash.reload')}
          </button>
          {!stale && (
            <button type="button" className="btn" onClick={onRetry}>
              {t('crash.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
