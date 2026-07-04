import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_OPTIONS, type LlmProfile, type SupportedLanguage } from '@meebox/shared';
import { invoke } from '../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../i18n';
import {
  connDraftCanSave,
  fromConnDraft,
  newProfileId,
  type ConnDraft,
  type ConnEntry,
} from '../settings';
import { WelcomeStep } from './steps/WelcomeStep';
import { PlatformStep } from './steps/PlatformStep';
import { LlmStep } from './steps/LlmStep';
import { DoneStep } from './steps/DoneStep';

/** Config collected by the wizard, handed to App to persist (config:setConnections etc.) before switching into the main UI */
export interface OnboardingResult {
  connection: ConnEntry;
  /** LLM profile the user filled in and that passed validation; null when skipped */
  llm: LlmProfile | null;
  /** Raw cache directory input (may contain `~`); App compares against the initial value to decide whether to config:setReposDir */
  reposDir: string;
}

interface OnboardingWizardProps {
  /** For uniqueness validation (usually empty on first launch) */
  existingLlmProfiles: LlmProfile[];
  /** Initial cache directory (config.workspace.repos_dir, unexpanded `~/...` form) */
  initialReposDir: string;
  /** Initial UI language (config.language raw value, empty string = auto); the welcome page echoes it back, falling back to OS preference when empty */
  initialLanguage: string;
  /** All config done → App persists + switches to main UI. On reject the wizard shows the error and allows a retry */
  onComplete: (result: OnboardingResult) => Promise<void>;
}

// Steps: welcome → platform (required) → LLM (skippable) → done
const STEP_KEYS = [
  'onboarding.stepWelcome',
  'onboarding.stepPlatform',
  'onboarding.stepLlm',
  'onboarding.stepDone',
] as const;

export function OnboardingWizard({
  existingLlmProfiles,
  initialReposDir,
  initialLanguage,
  onComplete,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

  // UI language: takes effect immediately (persist + renderer switch). Initial value is the currently effective language — falls back to matching OS preference when unconfigured.
  // The picker sits in the welcome page's bottom nav (reusing its divider), shown only on step 0.
  const [language, setLanguage] = useState<SupportedLanguage>(() =>
    resolveUiLanguage(initialLanguage),
  );
  const onLanguageChange = (next: SupportedLanguage): void => {
    if (next === language) return;
    setLanguage(next);
    void i18n.changeLanguage(next);
    persistLanguage(next);
    void invoke('config:setLanguage', { language: next }).catch(() => {
      /* A persist failure does not block the wizard: the renderer already switched, localStorage is already stored, and the overall persist on wizard completion is the fallback */
    });
  };

  const [connDraft, setConnDraft] = useState<ConnDraft>(() => ({
    id: newProfileId(),
    kind: 'github',
    display_name: '',
    base_url: '',
    token: '',
    protocol: 'pat',
  }));
  const [reposDir, setReposDir] = useState(initialReposDir);
  const [cacheOpen, setCacheOpen] = useState(false);

  const [llmDraft, setLlmDraft] = useState<LlmProfile>(() => ({
    id: newProfileId(),
    label: '',
    provider: 'openai-compatible',
    base_url: '',
    model: '',
    api_key: '',
  }));
  const [llmValid, setLlmValid] = useState(false);
  // null = not yet decided; true = enter with LLM; false = skip. The Done page shows the summary based on this
  const [includeLlm, setIncludeLlm] = useState<boolean | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const platformCanAdvance = connDraftCanSave(connDraft);

  const finish = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onComplete({
        connection: fromConnDraft(connDraft),
        llm: includeLlm ? llmDraft : null,
        reposDir,
      });
      // On success App unmounts this component, so no need to reset local state
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <ol className="onboarding-dots" aria-label={t('onboarding.progressAria')}>
          {STEP_KEYS.map((labelKey, i) => (
            <li
              key={labelKey}
              className={`onboarding-dot${i === step ? ' current' : ''}${i < step ? ' done' : ''}`}
            >
              <span className="onboarding-dot-mark">{i + 1}</span>
              <span className="onboarding-dot-label">{t(labelKey)}</span>
            </li>
          ))}
        </ol>

        <div className="onboarding-slide" key={step}>
          {step === 0 && <WelcomeStep onStart={() => setStep(1)} />}

          {step === 1 && (
            <PlatformStep
              connDraft={connDraft}
              onConnChange={setConnDraft}
              reposDir={reposDir}
              onReposDirChange={setReposDir}
              cacheOpen={cacheOpen}
              onToggleCache={() => setCacheOpen((v) => !v)}
            />
          )}

          {step === 2 && (
            <LlmStep
              draft={llmDraft}
              existing={existingLlmProfiles}
              onChange={setLlmDraft}
              onValidityChange={setLlmValid}
            />
          )}

          {step === 3 && <DoneStep submitting={submitting} error={submitError} />}
        </div>

        <div className="onboarding-nav">
          <div className="onboarding-nav-left">
            {step > 0 && step < 3 && (
              <button type="button" className="btn" onClick={() => setStep((s) => s - 1)}>
                {t('onboarding.back')}
              </button>
            )}
          </div>
          {/* Welcome page: the language picker sits in the bottom nav (reusing its divider), between the two (empty) ends → centered.
              Options use each language's own endonym, not the UI translation; selection takes effect immediately. */}
          {step === 0 && (
            <div className="onboarding-nav-language">
              <span className="muted">{t('onboarding.languageLabel')}</span>
              <select
                className="settings-input onboarding-language-select"
                value={language}
                onChange={(e) => onLanguageChange(e.target.value as SupportedLanguage)}
                aria-label={t('onboarding.languageLabel')}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.endonym}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="onboarding-nav-right">
            {step === 1 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(2)}
                disabled={!platformCanAdvance}
                title={platformCanAdvance ? undefined : t('onboarding.platformIncompleteHint')}
              >
                {t('onboarding.next')}
              </button>
            )}
            {step === 2 && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setIncludeLlm(false);
                    setStep(3);
                  }}
                >
                  {t('onboarding.skip')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setIncludeLlm(true);
                    setStep(3);
                  }}
                  disabled={!llmValid}
                  title={llmValid ? undefined : t('onboarding.llmIncompleteHint')}
                >
                  {t('onboarding.next')}
                </button>
              </>
            )}
            {step === 3 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void finish()}
                disabled={submitting}
              >
                {submitting ? t('onboarding.initializing') : t('onboarding.enterApp')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
