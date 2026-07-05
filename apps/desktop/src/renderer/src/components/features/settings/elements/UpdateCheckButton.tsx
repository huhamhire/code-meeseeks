import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UpdateCheckResult } from '@meebox/shared';
import { invoke } from '../../../../api';

/** "Check for updates" button (runtime environment section): manually queries the latest GitHub release, self-manages loading + result display. */
export function UpdateCheckButton({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  if (!enabled) {
    return (
      <>
        <button className="btn" type="button" disabled title={t('settings.updateDisabledTitle')}>
          {t('settings.checkUpdate')}
        </button>
        <span className="muted">{t('settings.updateDisabledHint')}</span>
      </>
    );
  }
  const run = async (): Promise<void> => {
    setChecking(true);
    try {
      setResult(await invoke('app:checkUpdate', undefined));
    } catch (e) {
      setResult({
        ok: false,
        hasUpdate: false,
        currentVersion: '',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <button
        className="btn"
        type="button"
        onClick={() => void run()}
        disabled={checking}
        title={t('settings.checkUpdateTitle')}
      >
        {checking ? t('settings.checking') : t('settings.checkUpdate')}
      </button>
      {result &&
        !checking &&
        (result.ok ? (
          result.hasUpdate ? (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => result.url && void invoke('app:openExternal', { url: result.url })}
            >
              {t('settings.updateAvailableLabel', { version: result.latestVersion })}
            </button>
          ) : (
            <span className="muted">{t('settings.upToDate')}</span>
          )
        ) : (
          <span className="error-text">{t('settings.checkFailed', { error: result.error })}</span>
        ))}
    </>
  );
}
