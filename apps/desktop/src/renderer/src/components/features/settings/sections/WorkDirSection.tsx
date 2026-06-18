import { useTranslation } from 'react-i18next';
import type { AppPaths } from '@meebox/shared';

export function WorkDirSection({ paths }: { paths: AppPaths }) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <h4>{t('settings.workDirTitle')}</h4>
      <div className="modal-kv">
        <div className="modal-kv-key">{t('settings.appRoot')}</div>
        <div className="modal-kv-val">{paths.appDir}</div>
        <div className="modal-kv-key">{t('settings.configKey')}</div>
        <div className="modal-kv-val">{paths.configFile}</div>
      </div>
    </section>
  );
}
