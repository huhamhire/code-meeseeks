import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { PencilIcon, TrashIcon } from '../../../common/icons';
import { PLATFORM_META } from '../../../common/PlatformIcon';

export function ConnectionsSection({
  connections,
  activeConnId,
  onAdd,
  onEdit,
  onSetActive,
  onRequestDelete,
}: {
  connections: Config['connections'];
  activeConnId: string;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onSetActive: (id: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.connectionsTitle')}</h4>
        <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
          {t('settings.addConnection')}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.connectionsHint')}
      </p>
      {connections.length === 0 ? (
        <p className="muted">{t('settings.connectionsEmpty')}</p>
      ) : (
        <div className="llm-profile-list">
          {connections.map((c) => {
            const isActive = c.id === activeConnId;
            const platformMeta = PLATFORM_META.find((m) => m.kind === c.kind);
            return (
              <div key={c.id} className={`llm-profile-row${isActive ? ' active' : ''}`}>
                <label className="llm-profile-active">
                  <input
                    type="radio"
                    name="conn-active"
                    checked={isActive}
                    onChange={() => onSetActive(c.id)}
                    aria-label={t('settings.enableConnectionAria')}
                  />
                </label>
                {platformMeta && (
                  <span className="llm-profile-icon" title={platformMeta.label}>
                    <platformMeta.Icon size={20} />
                  </span>
                )}
                <div className="llm-profile-meta">
                  <div className="llm-profile-title">
                    <span className="llm-profile-title-text">{c.display_name || c.id}</span>
                  </div>
                  <div className="muted llm-profile-sub">
                    {c.base_url} · clone via {c.clone.protocol === 'ssh' ? 'SSH' : 'PAT'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-icon btn-icon-primary"
                  onClick={() => onEdit(c.id)}
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-icon btn-icon-danger"
                  onClick={() => onRequestDelete(c.id)}
                  title={t('settings.deleteConnectionTitle')}
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
