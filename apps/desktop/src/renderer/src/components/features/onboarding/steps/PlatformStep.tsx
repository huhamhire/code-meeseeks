import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { ConnectionForm, PlatformPicker, type ConnDraft } from '../../settings';
import { FolderIcon } from '../../../common';

export function PlatformStep({
  connDraft,
  onConnChange,
  reposDir,
  onReposDirChange,
  cacheOpen,
  onToggleCache,
}: {
  connDraft: ConnDraft;
  onConnChange: (d: ConnDraft) => void;
  reposDir: string;
  onReposDirChange: (v: string) => void;
  cacheOpen: boolean;
  onToggleCache: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="onboarding-platform">
      <h2 className="onboarding-step-title">{t('onboarding.platformTitle')}</h2>
      <p className="muted onboarding-step-sub">{t('onboarding.platformSub')}</p>
      <div className="config-pick-grid">
        {/* 左：平台方案选择 */}
        <PlatformPicker
          value={connDraft.kind}
          onChange={(kind) => onConnChange({ ...connDraft, kind })}
          ariaLabel={t('onboarding.platformGroupAria')}
        />

        {/* 右：连接表单 + 折叠缓存目录 */}
        <div className="config-pick-form">
          <ConnectionForm draft={connDraft} onChange={onConnChange} autoFocus={false} />

          <div className="onboarding-advanced">
            <button
              type="button"
              className="onboarding-advanced-toggle"
              onClick={onToggleCache}
              aria-expanded={cacheOpen}
            >
              <span className={`onboarding-caret${cacheOpen ? ' open' : ''}`} aria-hidden="true">
                ▸
              </span>
              {t('onboarding.cacheDirToggle')}
            </button>
            {cacheOpen && (
              <div className="onboarding-advanced-body">
                <p className="muted" style={{ margin: '0 0 6px' }}>
                  {t('onboarding.cacheDirDesc')}
                </p>
                <div className="settings-edit-row" style={{ marginTop: 0 }}>
                  <input
                    type="text"
                    className="settings-input"
                    value={reposDir}
                    onChange={(e) => onReposDirChange(e.target.value)}
                    placeholder="~/.code-meeseeks/repos"
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => {
                      void (async () => {
                        const r = await invoke('dialog:pickDirectory', {
                          defaultPath: reposDir.trim() || undefined,
                          title: t('onboarding.pickCacheDirTitle'),
                        });
                        if (r.path) onReposDirChange(r.path);
                      })();
                    }}
                    title={t('onboarding.pickDir')}
                    aria-label={t('onboarding.pickDir')}
                  >
                    <FolderIcon />
                  </button>
                </div>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  {t('onboarding.cacheDirRestartNote')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
