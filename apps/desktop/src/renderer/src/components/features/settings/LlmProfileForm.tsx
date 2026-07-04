import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile, LlmProvider } from '@meebox/shared';
import i18n from '../../../i18n';
import { EyeIcon, EyeOffIcon } from '../../common';

export interface ProviderMeta {
  value: LlmProvider;
  label: string;
  hint: string;
  /** Example value / placeholder for the Model field */
  modelExample: string;
  /** Default endpoint for the Base URL field: used as a placeholder hint; if the user fills it in it's passed through to pr-agent, if left empty the downstream falls back to a default endpoint equivalent to this one */
  defaultBaseUrl: string;
  /** Whether the API Key field is required */
  needsKey: boolean;
}

// Order: overseas general (OpenAI / OpenAI-compatible / Anthropic) → three domestic providers (DeepSeek / Alibaba
// DashScope / Volcengine Ark) → fallback (OpenAI-compatible) → local CLI, so users can scan along the main flow
//
// label / hint use getters that resolve lazily via i18n.t: keeps the array shape unchanged (consumers read .label etc. directly),
// while letting the copy resolve with the current language (fall back to the literal when a brand name etc. has no matching key). modelExample is a plain model-name example
// (same across languages, not translated), a static literal, not in i18n.
function provider(
  // modelExample is a plain model-name example (same across languages, not translated), passed in as a static literal, **not in i18n**;
  // only label / hint go through i18n (give a literal for label when it's a brand name, omitting the key).
  meta: Omit<ProviderMeta, 'label' | 'hint'> & {
    /** Give a literal for label when there's no i18n key (brand name); omit when a key exists */
    label?: string;
  },
): ProviderMeta {
  const { value } = meta;
  return {
    ...meta,
    get label() {
      return meta.label ?? i18n.t(`llmProfileForm.provider.${value}.label`);
    },
    get hint() {
      return i18n.t(`llmProfileForm.provider.${value}.hint`);
    },
  };
}

export const LLM_PROVIDERS: ReadonlyArray<ProviderMeta> = [
  provider({
    value: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    needsKey: true,
    modelExample: 'gpt-4o / gpt-4o-mini',
  }),
  provider({
    value: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
    modelExample: 'claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5',
  }),
  provider({
    value: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    needsKey: true,
    modelExample: 'deepseek-chat / deepseek-reasoner',
  }),
  provider({
    value: 'dashscope',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    modelExample: 'qwen-max / qwen-plus / qwen-turbo / qwen3-235b-a22b',
  }),
  provider({
    value: 'volcengine-ark',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsKey: true,
    modelExample: 'ep-20240xxxxxx-xxxxx / doubao-pro-32k / doubao-1-5-pro-256k',
  }),
  // "OpenAI-compatible": the fallback general option; the main flow lets users scan the named providers first; local Ollama also uses it
  // (fill Base URL with http://localhost:11434/v1, leave the key empty).
  provider({
    value: 'openai-compatible',
    defaultBaseUrl: '',
    needsKey: true,
    modelExample: 'gpt-4o-mini / qwen2.5-72b-instruct',
  }),
  // "Local CLI" goes last: an advanced option that delegates model calls to a local command-line tool instead of connecting to the API directly.
  // modelExample is not shown (the model input uses cliCommandPlaceholder for cli), left empty.
  provider({
    value: 'cli',
    defaultBaseUrl: '',
    needsKey: false,
    modelExample: '',
  }),
];

export function getProviderMeta(p: LlmProvider): ProviderMeta {
  return LLM_PROVIDERS.find((x) => x.value === p) ?? LLM_PROVIDERS[0]!;
}

export function providerLabel(p: LlmProvider): string {
  return getProviderMeta(p).label;
}

export interface ProfileErrors {
  label?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
}

/**
 * Name slug rule: 1-32 chars, first char alphanumeric, the rest may contain `-` / `_`.
 * Avoids ambiguity in logs or file matching from spaces / CJK symbols / case-form differences / path separators.
 */
const LABEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Determine which profile fields are required based on provider metadata:
 *   - label required, and must conform to the slug rule
 *   - model always required (pr-agent must know which model to use)
 *   - api_key: required for providers with needsKey=true (local CLI / local services don't need it)
 *   - base_url: required for providers without a default value (only openai-compatible)
 *
 * existing is passed in for uniqueness validation (excludes its own id when editing).
 */
export function validateProfile(p: LlmProfile, existing: LlmProfile[]): ProfileErrors {
  const errors: ProfileErrors = {};
  const label = p.label.trim();
  if (!label) {
    errors.label = i18n.t('llmProfileForm.errorRequired');
  } else if (!LABEL_SLUG_RE.test(label)) {
    errors.label = i18n.t('llmProfileForm.errorLabelSlug');
  } else {
    const dup = existing.find(
      (x) => x.id !== p.id && x.label.trim().toLowerCase() === label.toLowerCase(),
    );
    if (dup) errors.label = i18n.t('llmProfileForm.errorLabelDuplicate');
  }

  // cli: the model field holds a local command name, with no base_url / api_key concept. Hidden validation—only allows
  // adapted commands (claude / codex, kept in sync with sitecustomize's _CLI_SPECS); other commands have no matching spec at runtime and won't run.
  // The hint doesn't name the supported commands (keeps it opaque), only gives generic "unsupported" feedback.
  if (p.provider === 'cli') {
    const cmd = p.model.trim().toLowerCase();
    if (!cmd) errors.model = i18n.t('llmProfileForm.errorRequired');
    else if (cmd !== 'claude' && cmd !== 'codex')
      errors.model = i18n.t('llmProfileForm.errorCliUnsupported');
    return errors;
  }

  const meta = getProviderMeta(p.provider);
  if (!p.model.trim()) errors.model = i18n.t('llmProfileForm.errorRequired');
  if (meta.needsKey && !p.api_key.trim()) errors.api_key = i18n.t('llmProfileForm.errorRequired');
  if (!meta.defaultBaseUrl && !p.base_url.trim())
    errors.base_url = i18n.t('llmProfileForm.errorRequired');
  return errors;
}

export function newProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Controlled LLM profile form (name / Provider / Model / Base URL / API Key + provider hint).
 * Field-level touched validation: only shows errors on fields that have been touched (blurred), avoiding an all-red state right after opening.
 *
 * The outer layer (settings-page sub-modal / wizard LLM step) uses `forceShowErrors` to expose
 * all required fields at once when Save is clicked; reports whether everything is currently valid via onValidityChange.
 */
export function LlmProfileForm({
  draft,
  existing,
  onChange,
  forceShowErrors = false,
  onValidityChange,
  hideProvider = false,
}: {
  draft: LlmProfile;
  existing: LlmProfile[];
  onChange: (draft: LlmProfile) => void;
  forceShowErrors?: boolean;
  onValidityChange?: (valid: boolean) => void;
  /** When provider is controlled externally (e.g. the wizard's left-side list), hide the in-form Provider dropdown */
  hideProvider?: boolean;
}) {
  const { t } = useTranslation();
  const [keyVisible, setKeyVisible] = useState(false);
  const [touched, setTouched] = useState<Record<keyof ProfileErrors, boolean>>({
    label: false,
    model: false,
    base_url: false,
    api_key: false,
  });
  const markTouched = (k: keyof ProfileErrors): void => {
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  };
  const providerMeta = getProviderMeta(draft.provider);
  const isCli = draft.provider === 'cli';
  const errors = validateProfile(draft, existing);
  const showError = (k: keyof ProfileErrors): boolean =>
    (forceShowErrors || touched[k]) && !!errors[k];
  const update = <K extends keyof LlmProfile>(field: K, value: LlmProfile[K]): void => {
    const next = { ...draft, [field]: value };
    onChange(next);
    onValidityChange?.(Object.keys(validateProfile(next, existing)).length === 0);
  };
  // Base URL placeholder: show the URL directly when there's a default endpoint; give an example + required hint when there's no default
  const baseUrlPlaceholder = providerMeta.defaultBaseUrl || 'https://your-endpoint.example.com/v1';

  return (
    <>
      <div className="modal-kv">
        <div className="modal-kv-key">
          {t('llmProfileForm.nameLabel')} <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className={`settings-input${showError('label') ? ' settings-input-error' : ''}`}
            value={draft.label}
            onChange={(e) => update('label', e.target.value)}
            onBlur={() => markTouched('label')}
            placeholder={
              isCli ? t('llmProfileForm.cliNamePlaceholder') : t('llmProfileForm.namePlaceholder')
            }
            autoFocus
            maxLength={32}
          />
        </div>
        {!hideProvider && (
          <>
            <div className="modal-kv-key">Provider</div>
            <div className="modal-kv-val">
              <select
                className="settings-input"
                value={draft.provider}
                onChange={(e) => update('provider', e.target.value as LlmProvider)}
              >
                {LLM_PROVIDERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <div className="modal-kv-key">
          {isCli ? t('llmProfileForm.cliCommandLabel') : 'Model'}{' '}
          <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className={`settings-input${showError('model') ? ' settings-input-error' : ''}`}
            value={draft.model}
            onChange={(e) => update('model', e.target.value)}
            onBlur={() => markTouched('model')}
            placeholder={
              isCli ? t('llmProfileForm.cliCommandPlaceholder') : providerMeta.modelExample
            }
          />
        </div>
        {/* cli mode doesn't connect to the API directly: no Base URL / API Key concept, hide the whole group */}
        {!isCli && (
          <>
            <div className="modal-kv-key">
              Base URL
              {!providerMeta.defaultBaseUrl && <span className="settings-required"> *</span>}
            </div>
            <div className="modal-kv-val">
              <input
                type="text"
                className={`settings-input${showError('base_url') ? ' settings-input-error' : ''}`}
                value={draft.base_url}
                onChange={(e) => update('base_url', e.target.value)}
                onBlur={() => markTouched('base_url')}
                placeholder={baseUrlPlaceholder}
              />
            </div>
            <div className="modal-kv-key">
              API Key{providerMeta.needsKey && <span className="settings-required"> *</span>}
            </div>
            <div className="modal-kv-val">
              <div className="settings-secret-row">
                <input
                  type={keyVisible ? 'text' : 'password'}
                  className={`settings-input${showError('api_key') ? ' settings-input-error' : ''}`}
                  value={draft.api_key}
                  onChange={(e) => update('api_key', e.target.value)}
                  onBlur={() => markTouched('api_key')}
                  placeholder={
                    providerMeta.needsKey ? 'sk-...' : t('llmProfileForm.apiKeyOptionalPlaceholder')
                  }
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm btn-icon"
                  onClick={() => setKeyVisible((v) => !v)}
                  title={keyVisible ? t('llmProfileForm.hide') : t('llmProfileForm.show')}
                  aria-label={keyVisible ? t('llmProfileForm.hide') : t('llmProfileForm.show')}
                >
                  {keyVisible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {isCli && (
        <p className="muted modal-footer">
          {t('llmProfileForm.cliWarningPrefix')}{' '}
          <code>{draft.model.trim() || t('llmProfileForm.cliCommandFallback')}</code>{' '}
          {t('llmProfileForm.cliWarningSuffix')}
        </p>
      )}
      <p className="muted modal-footer">{providerMeta.hint}</p>
    </>
  );
}
