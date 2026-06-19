import { useTranslation } from 'react-i18next';
import type { SyncProgressEvent } from '@meebox/shared';
import type { FormattedError } from '../../../../../errors';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function SyncProgress({ progress }: { progress: SyncProgressEvent | null }) {
  const { t } = useTranslation();
  if (!progress) {
    return (
      <span className="muted">
        <Spinner /> {t('diffView.syncingMirror')}
      </span>
    );
  }
  if (progress.phase === 'error') {
    return (
      <span className="diff-error">
        {t('diffView.syncFailed', { message: progress.message ?? t('diffView.unknownError') })}
      </span>
    );
  }
  // sync 完成后 IPC handler 还在跑 git diff 算变更文件列表，显示对应阶段提示
  if (progress.phase === 'done') {
    return (
      <span className="muted">
        <Spinner /> {t('diffView.syncDoneLoadingFiles')}
      </span>
    );
  }
  const label =
    progress.phase === 'start'
      ? (progress.message ?? t('diffView.preparingSync'))
      : (progress.stage ?? t('diffView.syncing'));
  const pct =
    progress.percent !== undefined && Number.isFinite(progress.percent) ? progress.percent : null;
  return (
    <div className="sync-progress">
      <div className="sync-progress-label">
        <span>{progress.repo}</span>
        <span>
          {label}
          {pct !== null ? ` · ${pct}%` : ''}
        </span>
      </div>
      {pct !== null && (
        <div className="sync-progress-bar">
          <div className="sync-progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** 整块替代 diff 区的硬错误展示（如变更文件列表本身拉不下来） */
export function BackendErrorView({
  err,
  scope,
  onRetry,
}: {
  err: FormattedError;
  scope: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="diff-empty diff-error backend-error-view">
      <p className="backend-error-title">
        <strong>{t('diffView.scopeLabel', { scope })}</strong>
        {err.title}
      </p>
      <pre className="backend-error-detail">{err.detail}</pre>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {t('diffView.retry')}
        </button>
      )}
    </div>
  );
}

/** 顶部细 banner，部分功能拉不下来但 diff 主体仍可用时显示 */
export function BackendErrorBanner({
  err,
  scope,
  onRetry,
  onDismiss,
}: {
  err: FormattedError;
  scope: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`backend-error-banner backend-error-banner-${err.kind}`} role="alert">
      <span className="backend-error-banner-icon" aria-hidden="true">
        ⚠
      </span>
      <span className="backend-error-banner-text">
        <strong>{t('diffView.scopeLabel', { scope })}</strong>
        <span className="muted">{err.title}</span>
        <span className="backend-error-banner-detail" title={err.detail}>
          {summarizeDetail(err.detail)}
        </span>
      </span>
      <span className="backend-error-banner-actions">
        {onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            {t('diffView.retry')}
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className="btn btn-sm backend-error-banner-dismiss"
            onClick={onDismiss}
            title={t('diffView.dismissNotificationTitle')}
            aria-label="dismiss"
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}

function summarizeDetail(detail: string): string {
  const firstLine = detail.split('\n')[0] ?? '';
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}
