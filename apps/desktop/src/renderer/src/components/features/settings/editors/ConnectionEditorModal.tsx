import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmModal, Modal } from '../../../common';
import { ConnectionForm, connDraftCanSave, type ConnDraft } from '../ConnectionForm';
import { PlatformPicker } from '../pickers/PlatformPicker';

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
  // Exit validation: snapshot the draft on open, compare against current to detect uncommitted changes
  const initialDraft = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initialDraft.current;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Closing (backdrop click / close key / cancel button) all routes through here: intercept with a confirm if dirty
  const requestClose = (): void => {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  };
  return (
    <>
      <Modal
        nested
        size="sm"
        onClose={requestClose}
        title={
          mode === 'add' ? t('settings.addConnectionTitle') : t('settings.editConnectionTitle')
        }
      >
        {/* Two columns: left picks the integration platform (reuses wizard layout), right fills the connection form.
          Platform selection is editable only when adding; editing an existing connection is read-only (base_url / token semantics vary by platform). */}
        <div className="config-pick-grid">
          <PlatformPicker
            value={draft.kind}
            onChange={(kind) => onChange({ ...draft, kind })}
            readOnly={mode === 'edit'}
            ariaLabel={t('settings.platform')}
          />
          <div className="config-pick-form">
            <ConnectionForm draft={draft} onChange={onChange} />
          </div>
        </div>
        <div
          className="settings-actions"
          style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
        >
          <button type="button" className="btn" onClick={requestClose}>
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
      {confirmDiscard && (
        <ConfirmModal
          nested
          danger
          title={t('settings.discardChangesTitle')}
          message={t('settings.discardChangesMessage')}
          confirmLabel={t('common.discard')}
          onConfirm={() => {
            setConfirmDiscard(false);
            onCancel();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}
