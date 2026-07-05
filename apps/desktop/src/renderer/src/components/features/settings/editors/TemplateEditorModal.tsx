import { useTranslation } from 'react-i18next';
import { DEFAULT_CODE_SUGGESTION_LAYOUT } from '@meebox/shared';
import { Modal } from '../../../common';

/**
 * Nested modal for editing a code-suggestion template (settings → Agent strategy). Reused for both fields:
 * - `spec`: a free-text spec injected into the LLM (extra_instructions for /improve /review /ask) — soft constraint.
 * - `layout`: a deterministic markdown layout for the whole draft comment when a finding becomes a draft, with
 *   placeholders `<TITLE>` / `<SUGGESTIONS>` / `<HOME>` / `<PR>` / `<MODEL>`.
 *
 * Editing writes to a draft held by the parent (useSettingsDraft.templateEditor); Cancel discards it, Confirm commits
 * to the field. The committed value is only persisted by the settings footer "Save" (same as the other draft editors).
 */
export function TemplateEditorModal({
  field,
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  field: 'spec' | 'layout';
  draft: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const isLayout = field === 'layout';
  return (
    <Modal
      nested
      size="md"
      onClose={onCancel}
      title={t(isLayout ? 'settings.codeSuggestionLayoutTitle' : 'settings.codeSuggestionSpecTitle')}
    >
      <p className="muted" style={{ margin: '0 0 10px' }}>
        {t(
          isLayout
            ? 'settings.codeSuggestionLayoutModalHint'
            : 'settings.codeSuggestionSpecModalHint',
        )}
      </p>
      {isLayout && (
        <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.85em' }}>
          {t('settings.codeSuggestionLayoutVars')}
        </p>
      )}
      <textarea
        className="settings-input"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          isLayout
            ? DEFAULT_CODE_SUGGESTION_LAYOUT
            : t('settings.codeSuggestionSpecPlaceholder')
        }
        spellCheck={false}
        rows={10}
        style={{
          width: '100%',
          minHeight: 200,
          resize: 'vertical',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          lineHeight: 1.5,
        }}
        aria-label={t(
          isLayout ? 'settings.codeSuggestionLayoutTitle' : 'settings.codeSuggestionSpecTitle',
        )}
      />
      <div
        className="settings-actions"
        style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
      >
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave}>
          {t('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}
