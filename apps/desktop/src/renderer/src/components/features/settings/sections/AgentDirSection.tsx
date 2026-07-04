import { useTranslation } from 'react-i18next';
import { FolderIcon } from '../../../common';
import { invoke } from '../../../../api';

export function AgentDirSection({
  value,
  onChange,
  onPick,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      {/* Header row: title on the left + blue "open current directory" button on the right (opens the
          active Agent directory in the system file manager for direct viewing / editing). Placed in the
          header row rather than the config row to avoid confusion with the directory picker button below. */}
      <div className="modal-section-head">
        <h4>{t('settings.agentDirTitle')}</h4>
        {/* Text button (not an icon): distinguished from the directory "pick" icon button below to avoid confusion. */}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void invoke('app:openAgentDir', undefined)}
          title={t('settings.openAgentDir')}
        >
          {t('settings.openAgentDir')}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.agentDirHint')}
      </p>
      <div className="settings-edit-row">
        <input
          type="text"
          className="settings-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('settings.agentDirPlaceholder')}
        />
        <button
          type="button"
          className="btn btn-icon"
          onClick={onPick}
          title={t('settings.pickDirectory')}
          aria-label={t('settings.pickDirectory')}
        >
          <FolderIcon />
        </button>
      </div>
    </section>
  );
}
