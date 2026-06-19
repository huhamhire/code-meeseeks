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
      {/* 标题行：左侧标题 + 右侧蓝色「打开当前目录」按钮（在系统文件管理器打开生效的 Agent 目录，
          便于直接查看 / 编辑文件）。放在标题行而非配置行，避免与下方的目录选择按钮混淆。 */}
      <div className="modal-section-head">
        <h4>{t('settings.agentDirTitle')}</h4>
        {/* 文案按钮（非图标）：与下方的目录「选择」图标按钮区分开，避免混淆。 */}
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
