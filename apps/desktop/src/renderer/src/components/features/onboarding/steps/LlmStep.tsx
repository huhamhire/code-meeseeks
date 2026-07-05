import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile } from '@meebox/shared';
import { LLM_PROVIDERS, LlmProfileForm, LlmProviderPicker } from '../../settings';
import { LlmProviderIcon } from '../../../common';

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
  // Two phases: first pick a provider (centered scrolling list) → once chosen the list collapses to the left and the config expands on the right
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
        // Phase one: centered provider pick list (scrolling)
        <div className="onboarding-provider-pick">
          {/* Phase one reuses the neutral config picker visuals, but each item trails a "›" hinting it's enterable and has no pre-selected highlight */}
          <div
            className="config-pick-list"
            role="radiogroup"
            aria-label={t('onboarding.providerPickAria')}
          >
            {LLM_PROVIDERS.map((p) => (
              <button
                key={p.value}
                type="button"
                className="config-pick-item"
                onClick={() => pick(p.value)}
              >
                <LlmProviderIcon provider={p.value} size={24} />
                <span className="config-pick-name config-pick-name-fill">{p.label}</span>
                {p.value === 'cli' && (
                  <span className="badge-experimental" title={t('settings.cliExperimentalHint')}>
                    {t('settings.experimental')}
                  </span>
                )}
                <span className="config-pick-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        // Phase two: left list (icons shifted left) + right config
        <div className="onboarding-llm-grid">
          <LlmProviderPicker
            value={draft.provider}
            onChange={(provider) => onChange({ ...draft, provider })}
          />
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
