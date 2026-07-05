import { useTranslation } from 'react-i18next';
import { Switch } from '../../../common';

// Selectable tiers for the max follow-up asks (1~5). The switch controls enable/disable independently, so 0 is not offered (0 equals off in the schema, reachable only by hand-editing config).
const MAX_FOLLOWUP_ASKS_OPTIONS = [1, 2, 3, 4, 5];
// Selectable tiers for the max code suggestions (2~8).
const MAX_CODE_SUGGESTIONS_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

/**
 * Agent strategy: a section extending Agent behavior controls, with sub-items shown row by row as an indented
 * "feature list" (leading dot + title + description, control on the right). Right-side controls aren't limited to
 * switches—auto follow-up ask uses a Switch, follow-up ask count / code suggestion count use dropdowns (the same
 * generic .settings-sublist-*). The follow-up ask count is only adjustable when auto follow-up ask is on (the dropdown
 * is disabled when off). Append later strategy items as one more row here.
 */
export function AgentStrategySection({
  autoFollowup,
  onAutoFollowupChange,
  maxFollowupAsks,
  onMaxFollowupAsksChange,
  maxCodeSuggestions,
  onMaxCodeSuggestionsChange,
  codeSuggestionSpec,
  onEditCodeSuggestionSpec,
  codeSuggestionLayout,
  onEditCodeSuggestionLayout,
}: {
  autoFollowup: boolean;
  onAutoFollowupChange: (next: boolean) => void;
  maxFollowupAsks: number;
  onMaxFollowupAsksChange: (next: number) => void;
  maxCodeSuggestions: number;
  onMaxCodeSuggestionsChange: (next: number) => void;
  codeSuggestionSpec: string;
  onEditCodeSuggestionSpec: () => void;
  codeSuggestionLayout: string;
  onEditCodeSuggestionLayout: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section modal-section-divider">
      <h4>{t('settings.agentStrategyTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.agentStrategyHint')}
      </p>
      <ul className="settings-sublist">
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.autoFollowupLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.autoFollowupHint')}</span>
          </div>
          <Switch
            checked={autoFollowup}
            onChange={onAutoFollowupChange}
            ariaLabel={t('settings.autoFollowupLabel')}
          />
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.maxFollowupAsksLabel')}</span>
            <span className="muted settings-sublist-desc">
              {t('settings.maxFollowupAsksHint')}
            </span>
          </div>
          {/* The follow-up ask count only takes effect when auto follow-up ask is on → disabled when off, avoiding the ambiguity of "switch off, yet count adjustable". */}
          <select
            className="settings-input settings-sublist-select"
            value={maxFollowupAsks}
            disabled={!autoFollowup}
            onChange={(e) => onMaxFollowupAsksChange(Number.parseInt(e.target.value, 10))}
            aria-label={t('settings.maxFollowupAsksLabel')}
          >
            {MAX_FOLLOWUP_ASKS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.maxCodeSuggestionsLabel')}</span>
            <span className="muted settings-sublist-desc">
              {t('settings.maxCodeSuggestionsHint')}
            </span>
          </div>
          <select
            className="settings-input settings-sublist-select"
            value={maxCodeSuggestions}
            onChange={(e) => onMaxCodeSuggestionsChange(Number.parseInt(e.target.value, 10))}
            aria-label={t('settings.maxCodeSuggestionsLabel')}
          >
            {MAX_CODE_SUGGESTIONS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </li>
        {/* Code-suggestion spec: a soft LLM directive (extra_instructions for /improve /review /ask) shaping how each suggestion is structured. Edited as free markdown in a nested modal. */}
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.codeSuggestionSpecLabel')}</span>
            <span className="muted settings-sublist-desc">
              {t('settings.codeSuggestionSpecHint')}
            </span>
          </div>
          <div className="settings-sublist-edit">
            <span
              className={`settings-status-chip ${codeSuggestionSpec.trim() ? 'is-on' : 'is-off'}`}
            >
              {codeSuggestionSpec.trim()
                ? t('settings.codeSuggestionSet')
                : t('settings.codeSuggestionDefault')}
            </span>
            <button type="button" className="btn btn-sm" onClick={onEditCodeSuggestionSpec}>
              {t('common.edit')}
            </button>
          </div>
        </li>
        {/* Code-suggestion layout: a deterministic markdown template for the whole draft comment when a finding becomes a draft (placeholders <TITLE>/<SUGGESTIONS>/<HOME>/<PR>/<MODEL>). */}
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">
              {t('settings.codeSuggestionLayoutLabel')}
            </span>
            <span className="muted settings-sublist-desc">
              {t('settings.codeSuggestionLayoutHint')}
            </span>
          </div>
          <div className="settings-sublist-edit">
            <span
              className={`settings-status-chip ${codeSuggestionLayout.trim() ? 'is-on' : 'is-off'}`}
            >
              {codeSuggestionLayout.trim()
                ? t('settings.codeSuggestionSet')
                : t('settings.codeSuggestionDefault')}
            </span>
            <button type="button" className="btn btn-sm" onClick={onEditCodeSuggestionLayout}>
              {t('common.edit')}
            </button>
          </div>
        </li>
      </ul>
    </section>
  );
}
