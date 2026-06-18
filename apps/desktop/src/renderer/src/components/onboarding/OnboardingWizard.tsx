import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_OPTIONS, type LlmProfile, type SupportedLanguage } from '@meebox/shared';
import { invoke } from '../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../i18n';
import {
  connDraftCanSave,
  fromConnDraft,
  type ConnDraft,
  type ConnEntry,
} from '../ConnectionForm';
import { newProfileId } from '../LlmProfileForm';
import { WelcomeStep } from './steps/WelcomeStep';
import { PlatformStep } from './steps/PlatformStep';
import { LlmStep } from './steps/LlmStep';
import { DoneStep } from './steps/DoneStep';

/** 向导收集到的配置，交由 App 落盘（config:setConnections 等）后切入主界面 */
export interface OnboardingResult {
  connection: ConnEntry;
  /** 用户填了并通过校验的 LLM 预设；跳过时为 null */
  llm: LlmProfile | null;
  /** 缓存目录原始输入（含 `~`）；App 与初值比较后决定是否 config:setReposDir */
  reposDir: string;
}

interface OnboardingWizardProps {
  /** 唯一性校验用（首启通常为空） */
  existingLlmProfiles: LlmProfile[];
  /** 缓存目录初值（config.workspace.repos_dir，未展开的 `~/...` 形态） */
  initialReposDir: string;
  /** UI 语言初值（config.language 原始值，空串=自动）；欢迎页据此回显，空则按 OS 偏好 */
  initialLanguage: string;
  /** 全部配置完成 → App 落盘 + 切主界面。reject 时向导展示错误允许重试 */
  onComplete: (result: OnboardingResult) => Promise<void>;
}

// 步骤：欢迎 → 平台（必填）→ LLM（可跳过）→ 完成
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

  // 界面语言：即时生效（写盘 + 渲染层切换）。初值取当前生效语言——无配置时按 OS 偏好匹配。
  // 选择项放在欢迎页底部 nav（复用其分割线），仅 step 0 显示。
  const [language, setLanguage] = useState<SupportedLanguage>(() =>
    resolveUiLanguage(initialLanguage),
  );
  const onLanguageChange = (next: SupportedLanguage): void => {
    if (next === language) return;
    setLanguage(next);
    void i18n.changeLanguage(next);
    persistLanguage(next);
    void invoke('config:setLanguage', { language: next }).catch(() => {
      /* 写盘失败不阻断向导：渲染层已切、localStorage 已存，完成向导后随整体落盘兜底 */
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
  // null = 还没决定；true = 带 LLM 进入；false = 跳过。Done 页据此显示摘要
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
      // 成功后由 App 卸载本组件，无需复位本地状态
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
          {/* 欢迎页：语言选择放在底部 nav（复用其分割线），居于两端（空）之间 → 居中显示。
              选项用各语言自身 endonym，不随 UI 翻译；选择即时生效。 */}
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
