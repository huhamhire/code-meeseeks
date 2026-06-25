import { useTranslation } from 'react-i18next';
import { POLLER_TIERS } from '../utils';
import { TierSlider } from './TierSlider';

export function PollerSection({
  value,
  onChange,
}: {
  /** 当前轮询秒数（字符串形态，与底层 pollerInput 一致） */
  value: string;
  /** 选定档位 → 回传该档秒数 */
  onChange: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <h4>{t('settings.pollerTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.pollerHint')}
      </p>
      <TierSlider
        tiers={POLLER_TIERS}
        value={Number.parseInt(value, 10) || 300}
        onChange={onChange}
        ariaLabel={t('settings.pollerSliderAria')}
        formatValue={() => t('settings.pollerSeconds', { n: value })}
      />
    </section>
  );
}
