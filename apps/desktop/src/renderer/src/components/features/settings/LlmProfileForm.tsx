import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmProfile, LlmProvider } from '@meebox/shared';
import i18n from '../../../i18n';
import { EyeIcon, EyeOffIcon } from '../../common';

export interface ProviderMeta {
  value: LlmProvider;
  label: string;
  hint: string;
  /** Model 字段示例值 / placeholder */
  modelExample: string;
  /** Base URL 字段的默认 endpoint：作占位提示；用户填了即透传给 pr-agent，留空则由下游回落到等同此处的默认 endpoint */
  defaultBaseUrl: string;
  /** API Key 字段是否必填 */
  needsKey: boolean;
}

// 顺序：海外通用 (OpenAI / OpenAI 兼容 / Anthropic) → 国内三家 (DeepSeek / 阿里
// 百炼 / 火山方舟) → 兜底 (OpenAI 兼容) → 本地 CLI，方便用户按主流程扫读
//
// label / hint 用 getter 经 i18n.t 惰性取值：保持数组形状不变（消费方直接读 .label 等），
// 同时让文案随当前语言解析（品牌名等无对应 key 时退回字面量）。modelExample 是纯模型名示例
// （各语言相同、不翻译），作静态字面量、不进 i18n。
function provider(
  // modelExample 是纯模型名示例（各语言相同、不翻译），作静态字面量传入、**不进 i18n**；
  // label / hint 才走 i18n（label 为品牌名时给字面量、省略 key）。
  meta: Omit<ProviderMeta, 'label' | 'hint'> & {
    /** label 无 i18n key（品牌名）时给字面量；有 key 时省略 */
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
  // 「OpenAI 兼容」：兜底通用项，主流程让用户先扫读具名 provider；本地 Ollama 也走它
  // （Base URL 填 http://localhost:11434/v1，密钥留空）。
  provider({
    value: 'openai-compatible',
    defaultBaseUrl: '',
    needsKey: true,
    modelExample: 'gpt-4o-mini / qwen2.5-72b-instruct',
  }),
  // 「本地 CLI」放最后：进阶项，转交本机命令行工具代调模型，不直连 API。
  // modelExample 不展示（model 输入框对 cli 用 cliCommandPlaceholder），置空。
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
 * 名称 slug 规则：1-32 字符，首位字母数字，其余可含 `-` / `_`。
 * 避免空格 / 中文符号 / 大写形态差异 / 路径分隔符造成日志或文件命中歧义。
 */
const LABEL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 按 provider 元信息判定 profile 哪些字段必填：
 *   - label 必填，且必须符合 slug 规则
 *   - model 永远必填（pr-agent 必须知道用哪个模型）
 *   - api_key：needsKey=true 的 provider 必填（本地 CLI / 本地服务不需要）
 *   - base_url：没有默认值的 provider 必填（仅 openai-compatible）
 *
 * existing 传入用于唯一性校验（编辑时排除自身 id）。
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

  // cli：model 字段填的是本机命令名，无 base_url / api_key 概念。隐藏校验——只放行已适配的
  // 命令（claude / codex，与 sitecustomize 的 _CLI_SPECS 同步），其余命令运行时无对应规格、跑不通。
  // 提示不点名受支持的命令（保持隐晦），仅给通用的「不受支持」反馈。
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
 * LLM 预设受控表单（名称 / Provider / Model / Base URL / API Key + provider 提示）。
 * 字段级 touched 校验：只对碰过（失焦）的字段亮错，避免刚打开一片红。
 *
 * 外层（设置页子模态 / 向导 LLM 步）通过 `forceShowErrors` 在点保存时一次性暴露
 * 所有必填项；通过 onValidityChange 上报当前是否全部合法。
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
  /** 由外部（如向导左侧列表）控制 provider 时，隐藏表单内的 Provider 下拉 */
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
  // Base URL placeholder：有默认 endpoint 时直接展示该 URL；没有默认值时给示例 + 必填提示
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
        {/* cli 模式不直连 API：没有 Base URL / API Key 概念，整组隐藏 */}
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
