import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { CopyIcon, EyeIcon, EyeOffIcon, Switch, SyncIcon } from '../../../common';

/**
 * Local API service listen section: master switch (section head) + an indented "feature list" showing
 * the listen address / access token line by line (leading dot + label + description, controls on the
 * right), stylistically consistent with the "Strategy" / "Notification" sections. The address is an
 * http://<host>:<port> combination; the token can be revealed / copied / regenerated, and is editable
 * under any switch state. When enabled with no token one is auto-generated; a non-loopback binding
 * shows a security warning. Listen address / port / token are all **draft-based** — they take effect
 * via config:setService with the bottom-bar "Save", and are discarded if not saved.
 */
export function ServiceSection({
  value,
  onChange,
  onRegenerateToken,
}: {
  value: Config['service'];
  onChange: (next: Config['service']) => void;
  /** Regenerate the token immediately (write to disk + take effect instantly); also used to auto-add one when enabled with no token. */
  onRegenerateToken: () => void;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const on = value.enabled;
  // Exposure check: a non-loopback binding (0.0.0.0 / LAN IP, etc.) is treated as accessible from the same subnet, so show a security warning.
  const host = value.host.trim();
  const exposed = host !== '' && !['127.0.0.1', 'localhost', '::1'].includes(host);

  const set = (patch: Partial<Config['service']>): void => onChange({ ...value, ...patch });

  // The listen address group and the token group share the same fixed width so the right-side controls of both rows align at their left and right edges; the input inside each group flexibly fills the remainder.
  const CONTROL_W = 320;

  const handleEnabled = (v: boolean): void => {
    if (v && !value.token) onRegenerateToken(); // enabled with no token → auto-generate one
    set({ enabled: v });
  };

  const copyToken = async (): Promise<void> => {
    if (!value.token) return;
    try {
      await navigator.clipboard.writeText(value.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* copy failure silenced */
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
