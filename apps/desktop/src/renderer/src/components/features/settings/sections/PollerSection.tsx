import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';
import { POLLER_TIERS, nearestPollerIdx } from '../utils';

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
  const pollerIdx = nearestPollerIdx(Number.parseInt(value, 10) || 300);
  const pollerFillPct = (pollerIdx / (POLLER_TIERS.length - 1)) * 100;
  return (
    <section className="modal-section">
      <h4>{t('settings.pollerTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.pollerHint')}
      </p>
      <div className="settings-edit-row" style={{ alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            type="range"
            className="settings-range"
            style={{ width: '100%', '--range-fill': `${pollerFillPct}%` } as CSSProperties}
            min={0}
            max={POLLER_TIERS.length - 1}
            step={1}
            value={pollerIdx}
            onChange={(e) => onChange(POLLER_TIERS[Number.parseInt(e.target.value, 10)]!)}
            aria-label={t('settings.pollerSliderAria')}
          />
          {/* 档位刻度：按 thumb 实际停靠位置绝对定位（thumb 宽 12px，两端内缩 6px），
              translateX(-50%) 居中对齐；当前档位高亮 */}
          <div className="settings-range-ticks">
            {POLLER_TIERS.map((tier, i) => {
              const frac = i / (POLLER_TIERS.length - 1);
              return (
                <span
                  key={tier}
                  className={i === pollerIdx ? 'active' : undefined}
                  style={{ left: `calc(${frac * 100}% + ${6 - frac * 12}px)` }}
                >
                  {tier}
                </span>
              );
            })}
          </div>
        </div>
        <span
          className="muted"
          style={{ minWidth: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        >
          {t('settings.pollerSeconds', { n: value })}
        </span>
      </div>
    </section>
  );
}
