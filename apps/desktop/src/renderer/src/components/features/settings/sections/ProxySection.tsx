import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';

export function ProxySection({
  proxy,
  onConfigure,
}: {
  proxy: Config['proxy'];
  onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const on = proxy.enabled && !!proxy.host;
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <div className="modal-section-head-title">
          <h4>{t('settings.proxyTitle')}</h4>
          {/* Enabled state shown as a chip (green=enabled / gray=disabled), visually consistent with
              other app states; the address isn't shown here, see the "Configure" dialog for details. */}
          <span className={`settings-status-chip ${on ? 'is-on' : 'is-off'}`}>
            {on ? t('settings.proxyEnabledStatus') : t('settings.proxyDisabledStatus')}
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onConfigure}>
          {t('settings.configure')}
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.proxyStatusHint')}
      </p>
    </section>
  );
}
