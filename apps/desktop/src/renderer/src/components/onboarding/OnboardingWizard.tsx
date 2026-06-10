import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile } from '@meebox/shared';
import { invoke } from '../../api';
import {
  ConnectionForm,
  connDraftCanSave,
  fromConnDraft,
  type ConnDraft,
  type ConnEntry,
} from '../ConnectionForm';
import { LLM_PROVIDERS, LlmProfileForm, newProfileId } from '../LlmProfileForm';
import { LlmProviderIcon } from '../LlmProviderIcon';
import { PLATFORM_META } from '../PlatformIcon';
import { FolderIcon, PullRequestIcon, SuccessBadgeIcon } from '../icons';

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
  onComplete,
}: OnboardingWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

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

function WelcomeStep({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  // 隐藏后门：连续快速点击 logo 7 次打开 DevTools（每次间隔 > 800ms 则计数清零）。
  // 首启向导下没有菜单 / 状态栏入口，给开发排障留一个不显眼的手势。
  const tapRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const onLogoTap = (): void => {
    const now = performance.now();
    const t = tapRef.current;
    t.count = now - t.last < 800 ? t.count + 1 : 1;
    t.last = now;
    if (t.count >= 7) {
      t.count = 0;
      void invoke('app:openDevTools', undefined);
    }
  };
  return (
    <div className="onboarding-welcome">
      <div className="onboarding-logo" onClick={onLogoTap} aria-hidden="true">
        <PullRequestIcon size={56} />
      </div>
      <h2 className="onboarding-title">{t('onboarding.welcomeTitle')}</h2>
      <p className="onboarding-lead">{t('onboarding.welcomeLead')}</p>
      <ul className="onboarding-points">
        <li>{t('onboarding.welcomePoint1')}</li>
        <li>{t('onboarding.welcomePoint2')}</li>
      </ul>
      <button type="button" className="btn btn-primary onboarding-start" onClick={onStart}>
        {t('onboarding.startConfig')}
      </button>
    </div>
  );
}

function PlatformStep({
  connDraft,
  onConnChange,
  reposDir,
  onReposDirChange,
  cacheOpen,
  onToggleCache,
}: {
  connDraft: ConnDraft;
  onConnChange: (d: ConnDraft) => void;
  reposDir: string;
  onReposDirChange: (v: string) => void;
  cacheOpen: boolean;
  onToggleCache: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="onboarding-platform">
      <h2 className="onboarding-step-title">{t('onboarding.platformTitle')}</h2>
      <p className="muted onboarding-step-sub">{t('onboarding.platformSub')}</p>
      <div className="onboarding-platform-grid">
        {/* 左：平台方案选择 */}
        <div className="onboarding-platform-list" role="radiogroup" aria-label={t('onboarding.platformGroupAria')}>
          {PLATFORM_META.map((p) => {
            // 可用平台（Bitbucket / GitHub）可点选并设 kind；GitLab 等未实现的置灰
            const selected = p.kind === connDraft.kind;
            return (
              <button
                type="button"
                key={p.kind}
                className={`onboarding-platform-item${selected ? ' selected' : ''}${
                  p.available ? '' : ' disabled'
                }`}
                role="radio"
                aria-checked={selected}
                aria-disabled={!p.available}
                disabled={!p.available}
                onClick={() => {
                  if (p.available) onConnChange({ ...connDraft, kind: p.kind as ConnDraft['kind'] });
                }}
              >
                <span className={`onboarding-platform-icon${p.available ? '' : ' muted-icon'}`}>
                  <p.Icon size={24} />
                </span>
                <span className="onboarding-platform-text">
                  <span className="onboarding-platform-name">{p.label}</span>
                  <span className="onboarding-platform-meta">{t(p.subKey)}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* 右：连接表单 + 折叠缓存目录 */}
        <div className="onboarding-platform-form">
          <ConnectionForm draft={connDraft} onChange={onConnChange} autoFocus={false} />

          <div className="onboarding-advanced">
            <button
              type="button"
              className="onboarding-advanced-toggle"
              onClick={onToggleCache}
              aria-expanded={cacheOpen}
            >
              <span className={`onboarding-caret${cacheOpen ? ' open' : ''}`} aria-hidden="true">
                ▸
              </span>
              {t('onboarding.cacheDirToggle')}
            </button>
            {cacheOpen && (
              <div className="onboarding-advanced-body">
                <p className="muted" style={{ margin: '0 0 6px' }}>
                  {t('onboarding.cacheDirDesc')}
                </p>
                <div className="settings-edit-row" style={{ marginTop: 0 }}>
                  <input
                    type="text"
                    className="settings-input"
                    value={reposDir}
                    onChange={(e) => onReposDirChange(e.target.value)}
                    placeholder="~/.code-meeseeks/repos"
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => {
                      void (async () => {
                        const r = await invoke('dialog:pickDirectory', {
                          defaultPath: reposDir.trim() || undefined,
                          title: t('onboarding.pickCacheDirTitle'),
                        });
                        if (r.path) onReposDirChange(r.path);
                      })();
                    }}
                    title={t('onboarding.pickDir')}
                    aria-label={t('onboarding.pickDir')}
                  >
                    <FolderIcon />
                  </button>
                </div>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  {t('onboarding.cacheDirRestartNote')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LlmStep({
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
          <div className="onboarding-provider-list" role="radiogroup" aria-label={t('onboarding.providerPickAria')}>
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

function DoneStep({ submitting, error }: { submitting: boolean; error: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="onboarding-done">
      <div className="onboarding-done-badge" aria-hidden="true">
        <SuccessBadgeIcon size={76} />
      </div>
      <h2 className="onboarding-title">{t('onboarding.doneTitle')}</h2>
      <p className="onboarding-lead">{t('onboarding.doneLead')}</p>
      {submitting && <p className="muted">{t('onboarding.doneSubmitting')}</p>}
      {error && <p className="error-text">{t('onboarding.doneError', { error })}</p>}
    </div>
  );
}
