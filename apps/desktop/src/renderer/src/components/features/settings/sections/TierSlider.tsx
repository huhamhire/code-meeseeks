import type { CSSProperties } from 'react';
import { nearestTierIdx } from '../utils';

/**
 * Discrete tier slider (numeric drag component): drags the tier index rather than the value, achieving non-linear step size + tick snapping.
 * Numeric configs such as poll interval / review concurrency / LLM context length share this component (see PollerSection etc.).
 * Only responsible for rendering the slider + ticks + right-side readout; specific tiers / text are passed in by the caller.
 */
export function TierSlider({
  tiers,
  value,
  onChange,
  ariaLabel,
  formatTick = String,
  formatValue,
}: {
  /** Tier value set (ascending); the slider moves over its indices. */
  tiers: readonly number[];
  /** Current value (snaps to the nearest tier when not on a tier). */
  value: number;
  /** Selected tier → passes back that tier's value. */
  onChange: (value: number) => void;
  ariaLabel: string;
  /** Tick text (defaults to showing the value directly). */
  formatTick?: (tier: number) => string;
  /** Right-side readout text; omit to not render the right-side readout (can hide when it's a plain unitless number that duplicates the ticks). */
  formatValue?: (value: number) => string;
}) {
  const idx = nearestTierIdx(tiers, value);
  const fillPct = (idx / (tiers.length - 1)) * 100;
  return (
    <div className="settings-edit-row" style={{ alignItems: 'center' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          type="range"
          className="settings-range"
          style={{ width: '100%', '--range-fill': `${fillPct}%` } as CSSProperties}
          min={0}
          max={tiers.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(tiers[Number.parseInt(e.target.value, 10)]!)}
          aria-label={ariaLabel}
        />
        {/* Tier ticks: absolutely positioned by the thumb's actual resting position (thumb is 12px wide, inset 6px at each end),
            translateX(-50%) for center alignment; current tier highlighted. */}
        <div className="settings-range-ticks">
          {tiers.map((tier, i) => {
            const frac = i / (tiers.length - 1);
            return (
              <span
                key={tier}
                className={i === idx ? 'active' : undefined}
                style={{ left: `calc(${frac * 100}% + ${6 - frac * 12}px)` }}
              >
                {formatTick(tier)}
              </span>
            );
          })}
        </div>
      </div>
      {formatValue && (
        <span
          className="muted"
          style={{ minWidth: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
        >
          {formatValue(value)}
        </span>
      )}
    </div>
  );
}
