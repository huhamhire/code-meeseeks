import { useTranslation } from 'react-i18next';
import { Modal } from '../../../common/Modal';
import { ConnectionForm, connDraftCanSave, type ConnDraft } from '../ConnectionForm';

export function ConnectionEditorModal({
  state,
  onChange,
  onSave,
  onCancel,
}: {
  state: { mode: 'add' | 'edit'; draft: ConnDraft };
  onChange: (draft: ConnDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { mode, draft } = state;
  const canSave = connDraftCanSave(draft);
  return (
    <Modal
      nested
      size="sm"
      onClose={onCancel}
      title={mode === 'add' ? t('settings.addConnectionTitle') : t('settings.editConnectionTitle')}
    >
      {/* 平台选择仅新增时可改；编辑既有连接不允许切平台（base_url/token 语义不同） */}
      {mode === 'add' && (
        <div className="modal-kv" style={{ marginBottom: 8 }}>
          <div className="modal-kv-key">{t('settings.platform')}</div>
          <div className="modal-kv-val">
            <select
              className="settings-input"
              value={draft.kind}
              onChange={(e) => onChange({ ...draft, kind: e.target.value as ConnDraft['kind'] })}
            >
              <option value="github">{t('settings.platformGithub')}</option>
              <option value="bitbucket-server">Bitbucket Server / Data Center</option>
              <option value="gitlab">{t('settings.platformGitlab')}</option>
            </select>
          </div>
        </div>
      )}
      <ConnectionForm draft={draft} onChange={onChange} />
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
          disabled={!canSave}
          title={!canSave ? t('settings.connSaveHint') : undefined}
        >
          {t('common.save')}
        </button>
      </div>
    </Modal>
  );
}
