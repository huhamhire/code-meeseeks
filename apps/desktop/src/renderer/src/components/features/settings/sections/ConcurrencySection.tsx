import { useTranslation } from 'react-i18next';
import { CONCURRENCY_TIERS } from '../utils';
import { TierSlider } from './TierSlider';

/**
 * 评审任务并发（pr_agent.max_concurrency，1~8）：同时执行的评审 run 数。
 * 复用轮询配置的数值拖拽组件（TierSlider）。
 */
export function ConcurrencySection({
  value,
  onChange,
}: {
  /** 当前并发数 */
  value: number;
  /** 选定档位 → 回传该档并发数 */
  onChange: (max: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section modal-section-divider">
      <h4>{t('settings.concurrencyTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.concurrencyHint')}
      </p>
      {/* 并发数为纯数字、无单位，且刻度已标 1~8 并高亮当前档 → 省去右侧重复读数。 */}
      <TierSlider
        tiers={CONCURRENCY_TIERS}
        value={value}
        onChange={onChange}
        ariaLabel={t('settings.concurrencySliderAria')}
      />
    </section>
  );
}
