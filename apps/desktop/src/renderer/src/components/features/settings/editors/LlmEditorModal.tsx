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
  // 退出校验：记下打开时的草稿快照，与当前比对判断是否有未提交改动
  const initialDraft = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== initialDraft.current;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 关闭（背景点击 / 关闭键 / 取消按钮）统一走这里：有改动则先拦截确认
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
        {/* 左右两栏：左选 provider（复用向导布局），右填该 provider 的配置（隐藏表单内冗余的 provider 下拉）。
            固定高度：两栏各自在其内滚动，切换 provider 时模态高度恒定、不抖动。 */}
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
