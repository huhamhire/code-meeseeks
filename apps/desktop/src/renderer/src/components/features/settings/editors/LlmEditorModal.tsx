import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile } from '@meebox/shared';
import { Modal } from '../../../common';
import { LlmProfileForm, validateProfile } from '../LlmProfileForm';

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
  // 点保存才把所有必填项暴露出来（LlmProfileForm 内部按 touched 渐进显示）
  const [forceShowErrors, setForceShowErrors] = useState(false);
  const isValid = Object.keys(validateProfile(draft, existing)).length === 0;
  const trySave = (): void => {
    if (!isValid) {
      setForceShowErrors(true);
      return;
    }
    onSave();
  };
  return (
    <Modal
      nested
      size="sm"
      onClose={onCancel}
      title={mode === 'add' ? t('settings.addLlmTitle') : t('settings.editLlmTitle')}
    >
      <LlmProfileForm
        draft={draft}
        existing={existing}
        onChange={onChange}
        forceShowErrors={forceShowErrors}
      />
      <div className="settings-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onCancel}>
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
  );
}
