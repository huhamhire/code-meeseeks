import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { ConnectionForm, type ConnDraft } from '../../settings';
import { PLATFORM_META } from '../../../common/PlatformIcon';
import { FolderIcon } from '../../../common/icons';

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
      <div className="onboarding-platform-grid">
        {/* 左：平台方案选择 */}
        <div
          className="onboarding-platform-list"
          role="radiogroup"
          aria-label={t('onboarding.platformGroupAria')}
        >
          {PLATFORM_META.map((p) => {
            // 可用平台（Bitbucket / GitHub / GitLab）可点选并设 kind；未实现的置灰
            const selected = p.kind === connDraft.kind;
            return (
              <button
                type="button"
                key={p.kind}
                className={`onboarding-platform-item${selected ? ' selected' : ''}${
                  p.available ? '' : ' disabled'
                }`}
                role="radio"
                aria-checked={selected}
                aria-disabled={!p.available}
                disabled={!p.available}
                onClick={() => {
                  if (p.available)
                    onConnChange({ ...connDraft, kind: p.kind as ConnDraft['kind'] });
                }}
              >
                <span className={`onboarding-platform-icon${p.available ? '' : ' muted-icon'}`}>
                  <p.Icon size={24} />
                </span>
                <span className="onboarding-platform-text">
                  <span className="onboarding-platform-name">{p.label}</span>
                  <span className="onboarding-platform-meta">{t(p.subKey)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* 右：连接表单 + 折叠缓存目录 */}
        <div className="onboarding-platform-form">
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
