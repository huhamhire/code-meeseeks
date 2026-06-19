import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { PencilIcon, TrashIcon, LlmProviderIcon } from '../../../common';
import { providerLabel } from '../LlmProfileForm';

export function LlmSection({
  llm,
  onAdd,
  onEdit,
  onSetActive,
  onDelete,
}: {
  llm: Config['llm'];
  onAdd: () => void;
  onEdit: (id: string) => void;
  onSetActive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.llmTitle')}</h4>
        <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
          {t('settings.addLlmProfile')}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.llmHint')}
      </p>
      {llm.profiles.length === 0 ? (
        <p className="muted">{t('settings.llmEmpty')}</p>
      ) : (
        <div className="llm-profile-list">
          {llm.profiles.map((p) => {
            const isActive = p.id === llm.active_id;
            const titleText = p.label || t('settings.llmProfileFallback', { id: p.id.slice(0, 4) });
            const isCli = p.provider === 'cli';
            return (
              <div key={p.id} className={`llm-profile-row${isActive ? ' active' : ''}`}>
                <label className="llm-profile-active">
                  <input
                    type="radio"
                    name="llm-active"
                    checked={isActive}
                    onChange={() => onSetActive(p.id)}
                    aria-label={t('settings.setActiveLlmAria')}
                  />
                </label>
                <span className="llm-profile-icon" title={providerLabel(p.provider)}>
                  <LlmProviderIcon provider={p.provider} size={20} />
                </span>
                <div className="llm-profile-meta">
                  <div className="llm-profile-title">
                    <span className="llm-profile-title-text">{titleText}</span>
                    {isCli && (
                      <span
                        className="badge-experimental"
                        title={t('settings.cliExperimentalHint')}
                      >
                        {t('settings.experimental')}
                      </span>
                    )}
                  </div>
                  <div className="muted llm-profile-sub">
                    {providerLabel(p.provider)}
                    {p.model ? ` · ${p.model}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-icon btn-icon-primary"
                  onClick={() => onEdit(p.id)}
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-icon btn-icon-danger"
                  onClick={() => onDelete(p.id)}
                  title={t('settings.deleteLlmProfileTitle')}
                  aria-label={t('common.delete')}
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
