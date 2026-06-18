import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile } from '@meebox/shared';
import { LLM_PROVIDERS, LlmProfileForm } from '../../settings/LlmProfileForm';
import { LlmProviderIcon } from '../../../common/LlmProviderIcon';

export function LlmStep({
  draft,
  existing,
  onChange,
  onValidityChange,
}: {
  draft: LlmProfile;
  existing: LlmProfile[];
  onChange: (d: LlmProfile) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useTranslation();
  // 两阶段：先选 provider（居中滚动列表）→ 选定后列表收到左侧、右侧展开配置
  const [chosen, setChosen] = useState(false);
  const pick = (provider: LlmProfile['provider']): void => {
    onChange({ ...draft, provider });
    setChosen(true);
  };
  return (
    <div className="onboarding-llm">
      <h2 className="onboarding-step-title">{t('onboarding.llmTitle')}</h2>
      <p className="muted onboarding-step-sub">{t('onboarding.llmSub')}</p>

      {!chosen ? (
        // 阶段一：居中的 provider 选择列表（滚动）
        <div className="onboarding-provider-pick">
          <p className="muted onboarding-provider-pick-hint">{t('onboarding.providerPickHint')}</p>
          <div
            className="onboarding-provider-list"
            role="radiogroup"
            aria-label={t('onboarding.providerPickAria')}
          >
            {LLM_PROVIDERS.map((p) => (
              <button
                key={p.value}
                type="button"
                className="onboarding-provider-item"
                onClick={() => pick(p.value)}
              >
                <LlmProviderIcon provider={p.value} size={28} />
                <span className="onboarding-provider-name">{p.label}</span>
                <span className="onboarding-provider-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        // 阶段二：左侧列表（图标左移）+ 右侧配置
        <div className="onboarding-llm-grid">
          <div className="onboarding-provider-list" role="radiogroup" aria-label="Provider">
            {LLM_PROVIDERS.map((p) => {
              const selected = p.value === draft.provider;
              return (
                <button
                  key={p.value}
                  type="button"
                  className={`onboarding-provider-item${selected ? ' selected' : ''}`}
                  onClick={() => onChange({ ...draft, provider: p.value })}
                  role="radio"
                  aria-checked={selected}
                >
                  <LlmProviderIcon provider={p.value} size={24} />
                  <span className="onboarding-provider-name">{p.label}</span>
                </button>
              );
            })}
          </div>
          <div className="onboarding-llm-form">
            <LlmProfileForm
              draft={draft}
              existing={existing}
              onChange={onChange}
              onValidityChange={onValidityChange}
              hideProvider
            />
          </div>
        </div>
      )}
    </div>
  );
}
