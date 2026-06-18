import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { Modal } from '../../../common/Modal';
import { EyeIcon, EyeOffIcon } from '../../../common/icons';
import { invoke } from '../../../../api';

export function ProxyEditorModal({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Config['proxy'];
  onChange: (next: Config['proxy']) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [test, setTest] = useState<{
    testing: boolean;
    result: { ok: boolean; reason?: string } | null;
  }>({ testing: false, result: null });
  const [pwVisible, setPwVisible] = useState(false);
  // 改任意字段都清掉上次测试结果（避免误导）
  const patch = (p: Partial<Config['proxy']>): void => {
    onChange({ ...draft, ...p });
    setTest({ testing: false, result: null });
  };
  return (
    <Modal
      nested
      size="md"
      style={{ maxWidth: 420 }}
      onClose={onCancel}
      title={t('settings.proxyTitle')}
    >
      <p className="muted" style={{ margin: '0 0 10px' }}>
        {t('settings.proxyModalHint')}
      </p>
      <label className="settings-secret-row">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          aria-label={t('settings.enableProxy')}
        />
        <span className="muted">{t('settings.enableProxy')}</span>
      </label>
      {draft.enabled && (
        <>
          {/* 字段名放输入框前（modal-kv 网格）；用户名 / 密码分上下两行，均可选 */}
          <div className="modal-kv" style={{ marginTop: 10, alignItems: 'center' }}>
            <div className="modal-kv-key">{t('settings.proxyHost')}</div>
            <div className="modal-kv-val">
              <input
                type="text"
                className="settings-input"
                value={draft.host}
                onChange={(e) => patch({ host: e.target.value.trim() })}
                placeholder={t('settings.proxyHostPlaceholder')}
                aria-label={t('settings.proxyHostAria')}
              />
            </div>
            <div className="modal-kv-key">{t('settings.proxyPort')}</div>
            <div className="modal-kv-val">
              <input
                type="number"
                className="settings-input"
                value={draft.port}
                min={1}
                max={65535}
                onChange={(e) => patch({ port: Number.parseInt(e.target.value, 10) || 0 })}
                aria-label={t('settings.proxyPortAria')}
              />
            </div>
            <div className="modal-kv-key">{t('settings.proxyUsername')}</div>
            <div className="modal-kv-val">
              <input
                type="text"
                className="settings-input"
                value={draft.username}
                onChange={(e) => patch({ username: e.target.value })}
                placeholder={t('settings.proxyUsernamePlaceholder')}
                aria-label={t('settings.proxyUsernameAria')}
                autoComplete="off"
              />
            </div>
            <div className="modal-kv-key">{t('settings.proxyPassword')}</div>
            <div className="modal-kv-val">
              <div className="settings-secret-row">
                <input
                  type={pwVisible ? 'text' : 'password'}
                  className="settings-input"
                  value={draft.password}
                  onChange={(e) => patch({ password: e.target.value })}
                  placeholder={t('settings.proxyPasswordPlaceholder')}
                  aria-label={t('settings.proxyPasswordAria')}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm btn-icon"
                  onClick={() => setPwVisible((v) => !v)}
                  title={pwVisible ? t('settings.hide') : t('settings.show')}
                  aria-label={pwVisible ? t('settings.hide') : t('settings.show')}
                >
                  {pwVisible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
              </div>
            </div>
          </div>
          <div className="settings-edit-row" style={{ marginTop: 10, alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn"
              disabled={test.testing || !draft.host}
              onClick={() => {
                void (async () => {
                  setTest({ testing: true, result: null });
                  try {
                    const r = await invoke('config:testProxy', { proxy: draft });
                    setTest({ testing: false, result: r });
                  } catch (e) {
                    setTest({
                      testing: false,
                      result: { ok: false, reason: e instanceof Error ? e.message : String(e) },
                    });
                  }
                })();
              }}
            >
              {test.testing ? t('settings.testing') : t('settings.testProxy')}
            </button>
            {test.result &&
              (test.result.ok ? (
                <span className="muted" style={{ color: '#16825d' }}>
                  {t('settings.proxyOk')}
                </span>
              ) : (
                <span className="error-text">✗ {test.result.reason ?? t('settings.testFailed')}</span>
              ))}
          </div>
        </>
      )}
      <div
        className="settings-actions"
        style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
      >
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={draft.enabled && !draft.host}
          title={draft.enabled && !draft.host ? t('settings.proxyHostRequired') : undefined}
        >
          {t('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}
