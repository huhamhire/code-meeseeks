import { useState } from 'react';
import type { LlmProfile, LlmProvider } from '@meebox/shared';
import { EyeIcon, EyeOffIcon } from './icons';

export interface ProviderMeta {
  value: LlmProvider;
  label: string;
  hint: string;
  /** Model 字段示例值 / placeholder */
  modelExample: string;
  /** Base URL 字段默认值（有就回显；填空字段时 pr-agent 会用它） */
  defaultBaseUrl: string;
  /** API Key 字段是否必填 */
  needsKey: boolean;
}

// 顺序：海外通用 (OpenAI / OpenAI 兼容 / Anthropic) → 国内三家 (DeepSeek / 阿里
// 百炼 / 火山方舟) → 本地 (Ollama)，方便用户按主流程扫读
export const LLM_PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    value: 'openai',
    label: 'OpenAI',
    hint: '官方 OpenAI API；Base URL 留空走默认 endpoint',
    modelExample: 'gpt-4o / gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
    needsKey: true,
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: '官方 Anthropic API；模型直接填型号名（claude-opus-4-8 等），会自动补 anthropic/ 前缀',
    modelExample: 'claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    hint: '官方 DeepSeek API；模型直接填型号名，会自动补 deepseek/ 前缀',
    modelExample: 'deepseek-chat / deepseek-reasoner',
    defaultBaseUrl: 'https://api.deepseek.com',
    needsKey: true,
  },
  {
    value: 'dashscope',
    label: '阿里百炼 (DashScope)',
    hint: '阿里云 DashScope OpenAI 兼容接入；含千问 (Qwen)、DeepSeek-on-DashScope 等。API Key 在 DashScope 控制台生成',
    modelExample: 'qwen-max / qwen-plus / qwen-turbo / qwen3-235b-a22b',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
  },
  {
    value: 'volcengine-ark',
    label: '火山方舟 (Volcengine Ark)',
    hint: '火山方舟 OpenAI 兼容接入；含豆包 (Doubao)、DeepSeek-on-Ark 等。模型用方舟 endpoint id (ep-...) 或预设模型名',
    modelExample: 'ep-20240xxxxxx-xxxxx / doubao-pro-32k / doubao-1-5-pro-256k',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    needsKey: true,
  },
  {
    value: 'ollama',
    label: 'Ollama',
    hint: '本地 Ollama 服务；模型直接填名字，会自动补 ollama/ 前缀',
    modelExample: 'qwen2.5 / llama3.1',
    defaultBaseUrl: 'http://localhost:11434',
    needsKey: false,
  },
  {
    value: 'cli',
    label: '本地 CLI（Claude Code）',
    hint: '由本机已安装并登录的 Claude Code 命令行执行评审，不直连 API、不填密钥；使用的模型与额度取决于你本地 claude 的登录态。一期仅支持 claude（codex 待后续版本）。',
    modelExample: 'claude',
    defaultBaseUrl: '',
    needsKey: false,
  },
  // 「OpenAI 兼容」放最后：它是兜底通用项，主流程让用户先扫读具名 provider
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容',
    hint: '任何遵循 OpenAI API 协议的服务（vLLM / FastChat / 自建代理 …）；必须填 Base URL',
    modelExample: 'gpt-4o-mini / qwen2.5-72b-instruct',
    defaultBaseUrl: '',
    needsKey: true,
  },
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
 *   - api_key：needsKey=true 的 provider 必填（Ollama 不需要）
 *   - base_url：没有默认值的 provider 必填（仅 openai-compatible）
 *
 * existing 传入用于唯一性校验（编辑时排除自身 id）。
 */
export function validateProfile(p: LlmProfile, existing: LlmProfile[]): ProfileErrors {
  const errors: ProfileErrors = {};
  const label = p.label.trim();
  if (!label) {
    errors.label = '必填';
  } else if (!LABEL_SLUG_RE.test(label)) {
    errors.label = '只允许 字母 / 数字 / - / _，1-32 字符';
  } else {
    const dup = existing.find(
      (x) => x.id !== p.id && x.label.trim().toLowerCase() === label.toLowerCase(),
    );
    if (dup) errors.label = '名称已存在';
  }

  // cli：model 字段填的是本机命令名（claude），无 base_url / api_key 概念。
  // 一期只放行 claude；codex 等先在 UI 可输入但校验拦下，等后续版本接通。
  if (p.provider === 'cli') {
    const cmd = p.model.trim().toLowerCase();
    if (!cmd) errors.model = '必填';
    else if (cmd !== 'claude') errors.model = '一期仅支持 claude（codex 待后续版本）';
    return errors;
  }

  const meta = getProviderMeta(p.provider);
  if (!p.model.trim()) errors.model = '必填';
  if (meta.needsKey && !p.api_key.trim()) errors.api_key = '必填';
  if (!meta.defaultBaseUrl && !p.base_url.trim()) errors.base_url = '必填';
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
  const showError = (k: keyof ProfileErrors): boolean => (forceShowErrors || touched[k]) && !!errors[k];
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
          名称 <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className={`settings-input${showError('label') ? ' settings-input-error' : ''}`}
            value={draft.label}
            onChange={(e) => update('label', e.target.value)}
            onBlur={() => markTouched('label')}
            placeholder="如 openai-prod / local-ollama"
            autoFocus
            maxLength={32}
          />
          {showError('label') && <p className="settings-field-error">{errors.label}</p>}
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
          {isCli ? 'CLI 命令' : 'Model'} <span className="settings-required">*</span>
        </div>
        <div className="modal-kv-val">
          <input
            type="text"
            className={`settings-input${showError('model') ? ' settings-input-error' : ''}`}
            value={draft.model}
            onChange={(e) => update('model', e.target.value)}
            onBlur={() => markTouched('model')}
            placeholder={isCli ? 'claude（一期仅支持 claude）' : providerMeta.modelExample}
          />
          {showError('model') && <p className="settings-field-error">{errors.model}</p>}
        </div>
        {/* cli 模式不直连 API：没有 Base URL / API Key 概念，整组隐藏 */}
        {!isCli && (
          <>
            <div className="modal-kv-key">
              Base URL{!providerMeta.defaultBaseUrl && <span className="settings-required"> *</span>}
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
              {showError('base_url') && <p className="settings-field-error">{errors.base_url}</p>}
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
                  placeholder={providerMeta.needsKey ? 'sk-...' : '该 provider 无需密钥（留空）'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm btn-icon"
                  onClick={() => setKeyVisible((v) => !v)}
                  title={keyVisible ? '隐藏' : '显示'}
                  aria-label={keyVisible ? '隐藏' : '显示'}
                >
                  {keyVisible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
              </div>
              {showError('api_key') && <p className="settings-field-error">{errors.api_key}</p>}
            </div>
          </>
        )}
      </div>
      {isCli && (
        <p className="muted modal-footer">
          ⚠️ 填写并启用此预设，即代表你授权 Code Meeseeks 调用本机的 <code>{draft.model.trim() || 'claude'}</code>{' '}
          命令行工具执行评审操作（在子进程中以你的本地登录态运行）。请确认已安装 Claude Code 并完成登录。
        </p>
      )}
      <p className="muted modal-footer">{providerMeta.hint}</p>
    </>
  );
}
