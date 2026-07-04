import { useTranslation } from 'react-i18next';
import { CONCURRENCY_TIERS } from '../utils';
import { TierSlider } from './TierSlider';

/**
 * Review task concurrency (pr_agent.max_concurrency, 1~8): the number of review runs executed simultaneously.
 * Reuses the numeric drag component (TierSlider) from the polling config.
 */
export function ConcurrencySection({
  value,
  onChange,
}: {
  /** Current concurrency count */
  value: number;
  /** Selected tier → pass back that tier's concurrency count */
  onChange: (max: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section modal-section-divider">
      <h4>{t('settings.concurrencyTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.concurrencyHint')}
      </p>
      {/* The concurrency count is a plain number with no unit, and the scale already marks 1~8 and highlights the current tier → omit the redundant readout on the right. */}
      <TierSlider
        tiers={CONCURRENCY_TIERS}
        value={value}
        onChange={onChange}
        ariaLabel={t('settings.concurrencySliderAria')}
      />
    </section>
  );
}
