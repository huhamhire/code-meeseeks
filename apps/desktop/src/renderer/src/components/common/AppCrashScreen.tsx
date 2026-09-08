import { useTranslation } from 'react-i18next';

/**
 * Full-window fallback for a crash in the app's root subtree.
 *
 * Without a boundary at the root, any error thrown while rendering unmounts the whole tree and leaves an empty `#root`
 * — which reads as a permanently black window, with no way back short of restarting the app. This screen is what the
 * user gets instead: what broke, and two ways out.
 *
 * `onRetry` re-renders the subtree, which is enough when the crash came from transient state (a stale record read
 * during an in-flight update); reloading rebuilds the renderer from scratch and is the way out when it did not.
 */
export function AppCrashScreen({ err, onRetry }: { err: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="app-crash" role="alert">
      <div className="app-crash-card">
        <h1 className="app-crash-title">{t('crash.title')}</h1>
        <p className="app-crash-hint">{t('crash.hint')}</p>
        <pre className="app-crash-detail">{err.message || String(err)}</pre>
        <div className="app-crash-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t('crash.retry')}
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            {t('crash.reload')}
          </button>
        </div>
      </div>
    </div>
  );
}
