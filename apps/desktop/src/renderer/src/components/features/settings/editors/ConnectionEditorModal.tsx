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
        title={
          mode === 'add' ? t('settings.addConnectionTitle') : t('settings.editConnectionTitle')
        }
      >
        {/* 左右两栏：左选集成平台（复用向导布局），右填连接表单。
          平台选择仅新增时可改；编辑既有连接只读（base_url / token 语义随平台而异）。 */}
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
