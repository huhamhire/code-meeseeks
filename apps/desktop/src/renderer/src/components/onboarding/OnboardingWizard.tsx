import { useState } from 'react';
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
import { FolderIcon } from '../icons';

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
const STEPS = ['欢迎', '代码平台', 'AI 模型', '完成'] as const;

export function OnboardingWizard({
  existingLlmProfiles,
  initialReposDir,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState(0);

  const [connDraft, setConnDraft] = useState<ConnDraft>(() => ({
    id: newProfileId(),
    kind: 'bitbucket-server',
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
        <ol className="onboarding-dots" aria-label="配置进度">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`onboarding-dot${i === step ? ' current' : ''}${i < step ? ' done' : ''}`}
            >
              <span className="onboarding-dot-mark">{i + 1}</span>
              <span className="onboarding-dot-label">{label}</span>
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
                上一步
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
                title={platformCanAdvance ? undefined : '请填完名称 / Base URL / Token'}
              >
                下一步
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
                  跳过
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setIncludeLlm(true);
                    setStep(3);
                  }}
                  disabled={!llmValid}
                  title={llmValid ? undefined : '请填完必填项，或点「跳过」'}
                >
                  下一步
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
                {submitting ? '初始化中…' : '进入应用'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="onboarding-welcome">
      <div className="onboarding-logo" aria-hidden="true">
        <svg width="56" height="56" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="4" cy="12" r="1.6" />
          <line x1="4" y1="5.6" x2="4" y2="10.4" />
          <circle cx="12" cy="12" r="1.6" />
          <path d="M12 10.4 V7 a3 3 0 0 0 -3 -3 H6.5" />
          <path d="M8 2 L6 4 L8 6" />
        </svg>
      </div>
      <h2 className="onboarding-title">欢迎使用 Code Meeseeks</h2>
      <p className="onboarding-lead">只需几步配置即可连接你的代码平台。</p>
      <ul className="onboarding-points">
        <li>连接你的代码平台，自动同步待你评审的 PR</li>
        <li>可选接入 AI 模型，一键 /review、/describe</li>
      </ul>
      <button type="button" className="btn btn-primary onboarding-start" onClick={onStart}>
        开始配置
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
  return (
    <div className="onboarding-platform">
      <h2 className="onboarding-step-title">连接代码平台</h2>
      <p className="muted onboarding-step-sub">选择平台方案并填写连接信息。</p>
      <div className="onboarding-platform-grid">
        {/* 左：平台方案选择 */}
        <div className="onboarding-platform-list" role="radiogroup" aria-label="代码平台">
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
                  <span className="onboarding-platform-meta">{p.sub}</span>
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
              缓存目录（可选）
            </button>
            {cacheOpen && (
              <div className="onboarding-advanced-body">
                <p className="muted" style={{ margin: '0 0 6px' }}>
                  本地仓库镜像 + worktree 的存放位置，可重建的缓存。留默认即可。
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
                          title: '选择缓存目录',
                        });
                        if (r.path) onReposDirChange(r.path);
                      })();
                    }}
                    title="选择目录"
                    aria-label="选择目录"
                  >
                    <FolderIcon />
                  </button>
                </div>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  改缓存目录需重启应用后完全生效。
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
  // 两阶段：先选 provider（居中滚动列表）→ 选定后列表收到左侧、右侧展开配置
  const [chosen, setChosen] = useState(false);
  const pick = (provider: LlmProfile['provider']): void => {
    onChange({ ...draft, provider });
    setChosen(true);
  };
  return (
    <div className="onboarding-llm">
      <h2 className="onboarding-step-title">接入 AI 模型（可选）</h2>
      <p className="muted onboarding-step-sub">配置后即可在 PR 上使用 /review、/describe 等能力。</p>

      {!chosen ? (
        // 阶段一：居中的 provider 选择列表（滚动）
        <div className="onboarding-provider-pick">
          <p className="muted onboarding-provider-pick-hint">选择要对接的 Provider</p>
          <div className="onboarding-provider-list" role="radiogroup" aria-label="选择 Provider">
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
  return (
    <div className="onboarding-done">
      <div className="onboarding-done-badge" aria-hidden="true">
        <svg width="76" height="76" viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" opacity="0.35" />
          <path
            className="onboarding-check-path"
            d="M15 27l7.5 7.5L38 18.5"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="onboarding-title">一切就绪 🎉</h2>
      <p className="onboarding-lead">
        配置完成！点下方按钮进入应用，Code Meeseeks 会开始同步待你评审的 PR。
      </p>
      {submitting && <p className="muted">正在初始化连接并拉取 PR…</p>}
      {error && <p className="error-text">初始化失败：{error}</p>}
    </div>
  );
}
