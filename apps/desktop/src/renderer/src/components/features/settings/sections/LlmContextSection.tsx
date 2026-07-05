import { useTranslation } from 'react-i18next';
import { LLM_CONTEXT_TIERS, formatTokens } from '../utils';
import { TierSlider } from './TierSlider';

/**
 * LLM context length: the upper limit of the context length (tokens) for trimming input content, with common tiers between 32k~1M.
 * Reuses the numeric drag component (TierSlider) from the polling config. Does not take effect in local CLI mode (the CLI tool manages context itself).
 */
export function LlmContextSection({
  value,
  onChange,
}: {
  /** Current context length (tokens) */
  value: number;
  /** Selected tier → pass back that tier's token count */
  onChange: (tokens: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <h4>{t('settings.llmContextTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.llmContextHint')}
      </p>
      <TierSlider
        tiers={LLM_CONTEXT_TIERS}
        value={value}
        onChange={onChange}
        ariaLabel={t('settings.llmContextSliderAria')}
        formatTick={formatTokens}
        formatValue={formatTokens}
      />
    </section>
  );
}
