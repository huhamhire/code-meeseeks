import type { CSSProperties } from 'react';
import { nearestTierIdx } from '../utils';

/**
 * 离散档位滑块（数值拖拽组件）：拖的是档位索引而非数值，从而实现非线性步长 + 刻度吸附。
 * 轮询间隔 / 评审并发 / LLM 上下文长度等数值配置共用此组件（见 PollerSection 等）。
 * 仅负责滑块 + 刻度 + 右侧读数的呈现；具体档位 / 文案由调用方传入。
 */
export function TierSlider({
  tiers,
  value,
  onChange,
  ariaLabel,
  formatTick = String,
  formatValue,
}: {
  /** 档位数值集合（升序）；滑块在其索引上移动。 */
  tiers: readonly number[];
  /** 当前数值（不在档位上时就近吸附到最接近档位）。 */
  value: number;
  /** 选定档位 → 回传该档数值。 */
  onChange: (value: number) => void;
  ariaLabel: string;
  /** 刻度文案（默认直接显示数值）。 */
  formatTick?: (tier: number) => string;
  /** 右侧读数文案；省略则不渲染右侧读数（纯数字无单位、与刻度重复时可隐藏）。 */
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
        {/* 档位刻度：按 thumb 实际停靠位置绝对定位（thumb 宽 12px，两端内缩 6px），
            translateX(-50%) 居中对齐；当前档位高亮。 */}
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
