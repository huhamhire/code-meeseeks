import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { CopyIcon, EyeIcon, EyeOffIcon, Switch, SyncIcon } from '../../../common';

/**
 * 本地 API 服务监听分区：总开关（分区头）+ 缩进「功能列表」逐行展示监听地址 / 访问令牌（行首圆点 +
 * 标签 + 说明，右侧控件），与「策略」「通知」等分区风格统一。地址为 http://<host>:<port> 组合，token
 * 可显示 / 复制 / 重新生成；任何开关状态下均可编辑。启用且无 token 时自动生成；非 loopback 绑定给安全
 * 警示。监听地址 / 端口 / token 均为**草稿制**——随底栏「保存」经 config:setService 生效，不保存则丢弃。
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

  // 监听地址组与令牌组共用同一固定宽度，使两行右侧控件左右边缘对齐；组内输入框自适应填充剩余。
  const CONTROL_W = 320;

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

      <ul className="settings-sublist">
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.serviceHostLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.serviceHostHint')}</span>
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, width: CONTROL_W }}
          >
            <span className="muted">http://</span>
            <input
              type="text"
              className="settings-input"
              style={{ flex: 1, minWidth: 0 }}
              value={value.host}
              onChange={(e) => set({ host: e.target.value })}
              placeholder="127.0.0.1"
              spellCheck={false}
            />
            <span className="muted">:</span>
            <input
              type="number"
              className="settings-input"
              style={{ flex: '0 0 auto', width: 72 }}
              min={1}
              max={65535}
              value={value.port}
              onChange={(e) => set({ port: Number.parseInt(e.target.value, 10) || 0 })}
            />
          </div>
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.serviceTokenLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.serviceTokenDesc')}</span>
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, width: CONTROL_W }}
          >
            <input
              type="text"
              className="settings-input"
              style={{ flex: 1, minWidth: 0 }}
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
              className="btn btn-icon"
              onClick={onRegenerateToken}
              title={t('settings.serviceTokenRegenerate')}
              aria-label={t('settings.serviceTokenRegenerate')}
            >
              <SyncIcon />
            </button>
          </div>
        </li>
      </ul>

      {exposed && (
        <p className="error-text" style={{ margin: '8px 0 0' }}>
          {t('settings.serviceExposeWarning')}
        </p>
      )}
      {copied && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {t('settings.serviceTokenCopied')}
        </p>
      )}
    </section>
  );
}
