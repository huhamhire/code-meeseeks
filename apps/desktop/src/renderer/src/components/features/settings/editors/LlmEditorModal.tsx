import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile } from '@meebox/shared';
import { ConfirmModal, Modal } from '../../../common';
import { LlmProfileForm, validateProfile } from '../LlmProfileForm';
import { LlmProviderPicker } from '../pickers/LlmProviderPicker';

export function LlmEditorModal({
  state,
  existing,
  onChange,
  onSave,
  onCancel,
}: {
  state: { mode: 'add' | 'edit'; draft: LlmProfile };
  existing: LlmProfile[];
  onChange: (draft: LlmProfile) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { mode, draft } = state;
  // Only reveal all required fields when Save is clicked (LlmProfileForm shows them progressively by touched)
  const [forceShowErrors, setForceShowErrors] = useState(false);
  const isValid = Object.keys(validateProfile(draft, existing)).length === 0;
  const trySave = (): void => {
    if (!isValid) {
      setForceShowErrors(true);
      return;
    }
    onSave();
  };
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
        title={mode === 'add' ? t('settings.addLlmTitle') : t('settings.editLlmTitle')}
      >
        {/* Two columns: left picks the provider (reuses wizard layout), right fills that provider's config (hides the form's redundant provider dropdown).
            Fixed height: each column scrolls within itself, so the modal height stays constant and doesn't jitter when switching provider. */}
        <div className="config-pick-grid config-pick-grid-fixed">
          <LlmProviderPicker
            value={draft.provider}
            onChange={(provider) => onChange({ ...draft, provider })}
          />
          <div className="config-pick-form">
            <LlmProfileForm
              draft={draft}
              existing={existing}
              onChange={onChange}
              forceShowErrors={forceShowErrors}
              hideProvider
            />
          </div>
        </div>
        <div className="settings-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={requestClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={trySave}
            disabled={forceShowErrors && !isValid}
            title={forceShowErrors && !isValid ? t('settings.fillRequiredHint') : undefined}
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
