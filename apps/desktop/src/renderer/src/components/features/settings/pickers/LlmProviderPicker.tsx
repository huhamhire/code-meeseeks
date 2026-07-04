import { useTranslation } from 'react-i18next';
import type { LlmProvider } from '@meebox/shared';
import { LlmProviderIcon } from '../../../common';
import { LLM_PROVIDERS } from '../LlmProfileForm';

/**
 * LLM provider picker list (left column): brand icon + name, single-select highlight.
 * The first-run wizard's LLM step and the settings panel's "LLM" sub-modal share the same visuals (config picker left/right layout, see config-picker.scss).
 */
export function LlmProviderPicker({
  value,
  onChange,
  iconSize = 24,
  ariaLabel = 'Provider',
}: {
  value: LlmProvider;
  onChange: (provider: LlmProvider) => void;
  iconSize?: number;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="config-pick-list" role="radiogroup" aria-label={ariaLabel}>
      {LLM_PROVIDERS.map((p) => {
        const selected = p.value === value;
        return (
          <button
            key={p.value}
            type="button"
            className={`config-pick-item${selected ? ' selected' : ''}`}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(p.value)}
          >
            <LlmProviderIcon provider={p.value} size={iconSize} />
            <span className="config-pick-name config-pick-name-fill">{p.label}</span>
            {p.value === 'cli' && (
              <span className="badge-experimental" title={t('settings.cliExperimentalHint')}>
                {t('settings.experimental')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
