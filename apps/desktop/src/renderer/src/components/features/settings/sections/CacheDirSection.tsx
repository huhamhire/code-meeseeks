import { useTranslation } from 'react-i18next';
import type { AppPaths } from '@meebox/shared';
import { FolderIcon } from '../../../common/icons';
import { formatBytes } from '../utils';

export function CacheDirSection({
  paths,
  value,
  onChange,
  onPick,
  totalBytes,
}: {
  paths: AppPaths;
  value: string;
  onChange: (v: string) => void;
  onPick: () => void;
  totalBytes: number | null;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <h4>{t('settings.cacheDirTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.cacheDirHint')}
      </p>
      <div className="modal-kv">
        <div className="modal-kv-key">{t('settings.currentDir')}</div>
        <div className="modal-kv-val">{paths.reposDir}</div>
        <div className="modal-kv-key">{t('settings.cacheUsage')}</div>
        <div className="modal-kv-val">
          {totalBytes === null ? t('settings.calculating') : formatBytes(totalBytes)}
        </div>
      </div>
      <div className="settings-edit-row">
        <input
          type="text"
          className="settings-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~/.code-meeseeks/repos"
        />
        <button
          type="button"
          className="btn btn-icon"
          onClick={onPick}
          title={t('settings.pickDirectory')}
          aria-label={t('settings.pickDirectory')}
        >
          <FolderIcon />
        </button>
      </div>
      <p className="muted modal-footer">{t('settings.cacheDirRestartNote')}</p>
    </section>
  );
}
