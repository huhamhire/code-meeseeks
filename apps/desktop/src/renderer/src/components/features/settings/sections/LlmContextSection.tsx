import { useTranslation } from 'react-i18next';
import { LLM_CONTEXT_TIERS, formatTokens } from '../utils';
import { TierSlider } from './TierSlider';

/**
 * LLM 上下文长度：裁剪输入内容的上下文长度上限（token），32k~1M 间的习惯档位。
 * 复用轮询配置的数值拖拽组件（TierSlider）。本地 CLI 模式不生效（CLI 工具自管上下文）。
 */
export function LlmContextSection({
  value,
  onChange,
}: {
  /** 当前上下文长度（token） */
  value: number;
  /** 选定档位 → 回传该档 token 数 */
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
