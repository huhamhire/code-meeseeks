import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { CopyIcon, EyeIcon, EyeOffIcon, Switch } from '../../../common';

/**
 * 本地 API 服务监听分区：开关 + 监听地址（仅本机 / 局域网）+ 端口 + bearer token（展示 / 显隐 / 复制 /
 * 重新生成）。默认关闭；启用且无 token 时自动生成。监听 0.0.0.0 暴露到局域网时给安全警示。token 经
 * config:generateServiceToken 立即写盘生效（不随整体保存）；开关 / 地址 / 端口随底栏「保存」生效。
 */
export function ServiceSection({
  value,
  onChange,
  onRegenerateToken,
}: {
  value: Config['service'];
  onChange: (next: Config['service']) => void;
  /** 立即重新生成 token（写盘 + 即时生效）；启用且无 token 时也由此自动补一枚。 */
  onRegenerateToken: () => void;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const on = value.enabled;
  // 暴露判定：非 loopback 绑定（0.0.0.0 / 局域网 IP 等）即视为可被同网段访问，给安全警示。
  const host = value.host.trim();
  const exposed = host !== '' && !['127.0.0.1', 'localhost', '::1'].includes(host);

  const set = (patch: Partial<Config['service']>): void => onChange({ ...value, ...patch });

  const handleEnabled = (v: boolean): void => {
    if (v && !value.token) onRegenerateToken(); // 启用且无 token → 自动生成一枚
    set({ enabled: v });
  };

  const copyToken = async (): Promise<void> => {
    if (!value.token) return;
    try {
      await navigator.clipboard.writeText(value.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 复制失败静默 */
    }
  };

  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <div className="modal-section-head-title">
          <h4>{t('settings.serviceTitle')}</h4>
        </div>
        <Switch checked={on} onChange={handleEnabled} ariaLabel={t('settings.serviceEnableLabel')} />
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.serviceHint')}
      </p>

      {/* 监听地址：http://<host>:<port> 两个输入框组合。host 默认 127.0.0.1（仅本机），
          可填 0.0.0.0 / 局域网 IP 开放到同网段。 */}
      <div style={{ margin: '0 0 8px' }}>
        <div className="settings-sublist-label" style={{ marginBottom: 4 }}>
          {t('settings.serviceHostLabel')}
        </div>
        <div className="settings-edit-row" style={{ alignItems: 'center' }}>
          <span className="muted">http://</span>
          <input
            type="text"
            className="settings-input"
            style={{ flex: 1 }}
            value={value.host}
            onChange={(e) => set({ host: e.target.value })}
            placeholder="127.0.0.1"
            spellCheck={false}
          />
          <span className="muted">:</span>
          <input
            type="number"
            className="settings-input"
            style={{ maxWidth: 96 }}
            min={1}
            max={65535}
            value={value.port}
            onChange={(e) => set({ port: Number.parseInt(e.target.value, 10) || 0 })}
          />
        </div>
        <p className="muted settings-sublist-desc" style={{ margin: '4px 0 0' }}>
          {t('settings.serviceHostHint')}
        </p>
      </div>

      {exposed && (
        <p className="error-text" style={{ margin: '4px 0 8px' }}>
          {t('settings.serviceExposeWarning')}
        </p>
      )}

      <div className="settings-edit-row">
        <input
          type="text"
          className="settings-input"
          readOnly
          value={
            value.token
              ? revealed
                ? value.token
                : '•'.repeat(Math.min(32, value.token.length))
              : ''
          }
          placeholder={t('settings.serviceTokenPlaceholder')}
        />
        <button
          type="button"
          className="btn btn-icon"
          disabled={!value.token}
          onClick={() => setRevealed((r) => !r)}
          title={t(revealed ? 'settings.serviceTokenHide' : 'settings.serviceTokenReveal')}
          aria-label={t(revealed ? 'settings.serviceTokenHide' : 'settings.serviceTokenReveal')}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <button
          type="button"
          className="btn btn-icon"
          disabled={!value.token}
          onClick={() => void copyToken()}
          title={t('settings.serviceTokenCopy')}
          aria-label={t('settings.serviceTokenCopy')}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRegenerateToken}
          title={t('settings.serviceTokenRegenerate')}
        >
          {t('settings.serviceTokenRegenerate')}
        </button>
      </div>
      {copied && <span className="muted">{t('settings.serviceTokenCopied')}</span>}
    </section>
  );
}
