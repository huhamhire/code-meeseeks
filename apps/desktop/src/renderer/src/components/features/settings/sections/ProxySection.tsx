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
          {/* 启用状态用 chip 表达（绿=已启用/灰=未启用），与应用其它状态视觉一致；
              地址不在此展示，详情见「配置」弹窗。 */}
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
