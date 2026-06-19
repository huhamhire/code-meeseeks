import type { LlmProvider } from '@meebox/shared';
import { LlmProviderIcon } from '../../../common';
import { LLM_PROVIDERS } from '../LlmProfileForm';

/**
 * LLM provider 选择列表（左侧栏）：品牌图标 + 名称，单选高亮。
 * 首启向导 LLM 步与设置面板「LLM」子模态共用同一视觉（配置选择器左右布局，见 config-picker.scss）。
 */
export function LlmProviderPicker({
  value,
  onChange,
  scroll = false,
  iconSize = 24,
  ariaLabel = 'Provider',
}: {
  value: LlmProvider;
  onChange: (provider: LlmProvider) => void;
  /** 列表项较多时限高滚动（如设置子模态内，避免撑高模态） */
  scroll?: boolean;
  iconSize?: number;
  ariaLabel?: string;
}) {
  return (
    <div
      className={`config-pick-list${scroll ? ' config-pick-list-scroll' : ''}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
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
          </button>
        );
      })}
    </div>
  );
}
