import { useEffect, useState } from 'react';
import type { AppInfo, AppPaths, Config, LlmProfile, LlmProvider } from '@pr-pilot/shared';
import { invoke } from '../api';

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** LLM 配置改动后通知父级同步状态（StatusBar chip 等） */
  onLlmChange?: (llm: Config['llm']) => void;
  onClose: () => void;
}

interface ProviderMeta {
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

const LLM_PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    value: 'openai',
    label: 'OpenAI',
    hint: '官方 OpenAI API；Base URL 留空走默认 endpoint',
    modelExample: 'gpt-4o / gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com',
    needsKey: true,
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容',
    hint: '任何遵循 OpenAI API 协议的服务（vLLM / FastChat / 自建代理 …）；必须填 Base URL',
    modelExample: 'gpt-4o-mini / qwen2.5-72b-instruct',
    defaultBaseUrl: '',
    needsKey: true,
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    hint: '模型用 deepseek/<name> 这样带前缀的写法',
    modelExample: 'deepseek/deepseek-v4-pro / deepseek/deepseek-v4-flash',
    defaultBaseUrl: 'https://api.deepseek.com',
    needsKey: true,
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: '模型用 anthropic/claude-3-5-sonnet 等带前缀的写法',
    modelExample: 'anthropic/claude-3-5-sonnet / anthropic/claude-3-haiku',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
  },
  {
    value: 'ollama',
    label: 'Ollama',
    hint: '本地 Ollama 服务；模型用 ollama/<name> 这样带前缀的写法',
    modelExample: 'ollama/qwen2.5 / ollama/llama3.1',
    defaultBaseUrl: 'http://localhost:11434',
    needsKey: false,
  },
];

function getProviderMeta(p: LlmProvider): ProviderMeta {
  return LLM_PROVIDERS.find((x) => x.value === p) ?? LLM_PROVIDERS[0]!;
}

function providerLabel(p: LlmProvider): string {
  return getProviderMeta(p).label;
}

interface ProfileErrors {
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
function validateProfile(p: LlmProfile, existing: LlmProfile[]): ProfileErrors {
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

  const meta = getProviderMeta(p.provider);
  if (!p.model.trim()) errors.model = '必填';
  if (meta.needsKey && !p.api_key.trim()) errors.api_key = '必填';
  if (!meta.defaultBaseUrl && !p.base_url.trim()) errors.base_url = '必填';
  return errors;
}

function newProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function SettingsModal({
  info,
  paths,
  config,
  onLlmChange,
  onClose,
}: SettingsModalProps) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const [reposDirInput, setReposDirInput] = useState(config.workspace.repos_dir);
  const [savingReposDir, setSavingReposDir] = useState(false);
  const [reposDirSaved, setReposDirSaved] = useState(false);
  const [reposDirError, setReposDirError] = useState<string | null>(null);

  const [rules, setRules] = useState<Config['rules']>(config.rules);
  const [rulesDirInput, setRulesDirInput] = useState(config.rules.dir);
  const [savingRules, setSavingRules] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);

  // LLM Provider：主面板只渲染已保存列表 + 切换/删除 = 自动持久化。
  // 新增 / 修改单条走子模态框，模态框内"保存"才会写回 config.yaml。
  const [llm, setLlm] = useState<Config['llm']>(config.llm);
  const [llmEditor, setLlmEditor] = useState<
    | { mode: 'add' | 'edit'; draft: LlmProfile }
    | null
  >(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  const [totalBytes, setTotalBytes] = useState<number | null>(null);

  useEffect(() => {
    invoke('repo:getTotalSize', undefined)
      .then((r) => setTotalBytes(r.totalBytes))
      .catch(() => setTotalBytes(0));
  }, []);

  const openConfigFile = async (): Promise<void> => {
    setOpening(true);
    setOpenError(null);
    try {
      await invoke('app:openConfigFile', undefined);
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const saveReposDir = async (): Promise<void> => {
    if (savingReposDir) return;
    const next = reposDirInput.trim();
    if (!next) return;
    setSavingReposDir(true);
    setReposDirError(null);
    try {
      await invoke('config:setReposDir', { reposDir: next });
      setReposDirSaved(true);
    } catch (e) {
      setReposDirError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingReposDir(false);
    }
  };

  const reposDirChanged = reposDirInput.trim() !== config.workspace.repos_dir;

  const rulesChanged =
    rulesDirInput.trim() !== rules.dir || rules.enabled !== config.rules.enabled;
  const saveRules = async (): Promise<void> => {
    if (savingRules) return;
    setSavingRules(true);
    setRulesError(null);
    try {
      const next: Config['rules'] = {
        dir: rulesDirInput.trim(),
        enabled: rules.enabled,
      };
      await invoke('config:setRules', { rules: next });
      setRules(next);
      setRulesSaved(true);
    } catch (e) {
      setRulesError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingRules(false);
    }
  };

  const persistLlm = async (next: Config['llm']): Promise<void> => {
    setLlmError(null);
    try {
      await invoke('config:setLlm', { llm: next });
      setLlm(next);
      onLlmChange?.(next);
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    }
  };
  const openAddProfile = (): void => {
    setLlmEditor({
      mode: 'add',
      draft: {
        id: newProfileId(),
        label: '',
        provider: 'openai-compatible',
        base_url: '',
        model: '',
        api_key: '',
      },
    });
  };
  const openEditProfile = (id: string): void => {
    const p = llm.profiles.find((x) => x.id === id);
    if (!p) return;
    setLlmEditor({ mode: 'edit', draft: { ...p } });
  };
  const closeEditor = (): void => setLlmEditor(null);
  const saveEditor = async (): Promise<void> => {
    if (!llmEditor) return;
    const { mode, draft } = llmEditor;
    const profiles =
      mode === 'add'
        ? [...llm.profiles, draft]
        : llm.profiles.map((p) => (p.id === draft.id ? draft : p));
    const active_id = mode === 'add' && !llm.active_id ? draft.id : llm.active_id;
    await persistLlm({ profiles, active_id });
    setLlmEditor(null);
  };
  const deleteProfile = async (id: string): Promise<void> => {
    const profiles = llm.profiles.filter((p) => p.id !== id);
    const active_id = llm.active_id === id ? (profiles[0]?.id ?? '') : llm.active_id;
    await persistLlm({ profiles, active_id });
  };
  const setActive = async (id: string): Promise<void> => {
    if (llm.active_id === id) return;
    await persistLlm({ ...llm, active_id: id });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>设置</h3>
          <button className="btn" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <section className="modal-section">
            <h4>工作目录</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">应用根</div>
              <div className="modal-kv-val">{paths.appDir}</div>
              <div className="modal-kv-key">配置</div>
              <div className="modal-kv-val">{paths.configFile}</div>
            </div>
          </section>

          <section className="modal-section">
            <h4>仓库镜像</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">当前 repos_dir</div>
              <div className="modal-kv-val">{paths.reposDir}</div>
              <div className="modal-kv-key">镜像总占用</div>
              <div className="modal-kv-val">
                {totalBytes === null ? '计算中…' : formatBytes(totalBytes)}
              </div>
            </div>
            <div className="settings-edit-row">
              <input
                type="text"
                className="settings-input"
                value={reposDirInput}
                onChange={(e) => {
                  setReposDirInput(e.target.value);
                  setReposDirSaved(false);
                  setReposDirError(null);
                }}
                placeholder="~/.pr-pilot/repos"
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void (async () => {
                    const r = await invoke('dialog:pickDirectory', {
                      defaultPath: reposDirInput.trim() || paths.reposDir,
                      title: '选择仓库镜像目录',
                    });
                    if (r.path) {
                      setReposDirInput(r.path);
                      setReposDirSaved(false);
                      setReposDirError(null);
                    }
                  })();
                }}
                title="打开系统目录选择器"
              >
                选择…
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveReposDir()}
                disabled={!reposDirChanged || savingReposDir}
              >
                {savingReposDir ? '保存中…' : '保存'}
              </button>
            </div>
            {reposDirSaved && (
              <p className="muted modal-footer">
                已写入 config.yaml。重启应用生效。原 repos_dir
                下的镜像不会自动迁移，请手动移动或下次访问时重新 clone。
              </p>
            )}
            {reposDirError && <p className="error-text">{reposDirError}</p>}
          </section>

          <section className="modal-section">
            <h4>规则目录</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              目录下每个 <code>.md</code> 是一条个性化 review 规则。
            </p>
            <div className="settings-edit-row">
              <input
                type="text"
                className="settings-input"
                value={rulesDirInput}
                onChange={(e) => {
                  setRulesDirInput(e.target.value);
                  setRulesSaved(false);
                  setRulesError(null);
                }}
                placeholder="可选；如 ~/code/team-pr-rules"
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void (async () => {
                    const r = await invoke('dialog:pickDirectory', {
                      defaultPath: rulesDirInput.trim() || paths.appDir,
                      title: '选择规则目录',
                    });
                    if (r.path) {
                      setRulesDirInput(r.path);
                      setRulesSaved(false);
                      setRulesError(null);
                    }
                  })();
                }}
                title="打开系统目录选择器"
              >
                选择…
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveRules()}
                disabled={!rulesChanged || savingRules}
              >
                {savingRules ? '保存中…' : '保存'}
              </button>
            </div>
            <label className="settings-secret-row" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={rules.enabled}
                onChange={(e) => {
                  setRules((r) => ({ ...r, enabled: e.target.checked }));
                  setRulesSaved(false);
                }}
                aria-label="启用规则"
              />
              <span className="muted">启用规则</span>
            </label>
            {rulesSaved && (
              <p className="muted modal-footer">已写入 config.yaml；下次 pragent:run 立即生效。</p>
            )}
            {rulesError && <p className="error-text">{rulesError}</p>}
          </section>

          <section className="modal-section">
            <h4>LLM 模型</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              选择活跃配置决定 PR Agent 调用哪个模型；修改即时生效，不需要重启。
            </p>
            {llm.profiles.length === 0 ? (
              <p className="muted">尚未配置；添加一条以启用 PR Agent。</p>
            ) : (
              <div className="llm-profile-list">
                {llm.profiles.map((p) => {
                  const isActive = p.id === llm.active_id;
                  const titleText = p.label || `配置 ${p.id.slice(0, 4)}`;
                  return (
                    <div
                      key={p.id}
                      className={`llm-profile-row${isActive ? ' active' : ''}`}
                    >
                      <label className="llm-profile-active">
                        <input
                          type="radio"
                          name="llm-active"
                          checked={isActive}
                          onChange={() => void setActive(p.id)}
                          aria-label="设为活跃"
                        />
                      </label>
                      <div className="llm-profile-meta">
                        <div className="llm-profile-title">{titleText}</div>
                        <div className="muted llm-profile-sub">
                          {providerLabel(p.provider)}
                          {p.model ? ` · ${p.model}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => openEditProfile(p.id)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void deleteProfile(p.id)}
                        title="删除该配置"
                      >
                        删除
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="settings-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-primary" onClick={openAddProfile}>
                + 添加配置
              </button>
            </div>
            {llmError && <p className="error-text">{llmError}</p>}
          </section>

          <section className="modal-section">
            <h4>轮询</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">间隔</div>
              <div className="modal-kv-val">{config.poller.interval_seconds} 秒</div>
            </div>
          </section>

          <section className="modal-section">
            <h4>连接 ({config.connections.length})</h4>
            {config.connections.length === 0 ? (
              <p className="muted">未配置任何连接。编辑 config.yaml 添加一条。</p>
            ) : (
              <ul className="connection-list">
                {config.connections.map((c) => (
                  <li key={c.id}>
                    <strong>{c.display_name}</strong>{' '}
                    <span className="muted">({c.id})</span>
                    <br />
                    <span className="muted">
                      {c.kind} · {c.base_url} · clone via{' '}
                      {c.clone.protocol === 'pat'
                        ? 'Personal Access Token (PAT)'
                        : c.clone.protocol === 'ssh'
                          ? 'SSH'
                          : c.clone.protocol}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="modal-section">
            <h4>运行环境</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">Electron</div>
              <div className="modal-kv-val">{info.electronVersion}</div>
              <div className="modal-kv-key">Node</div>
              <div className="modal-kv-val">{info.nodeVersion}</div>
              <div className="modal-kv-key">平台</div>
              <div className="modal-kv-val">{info.platform}</div>
            </div>
          </section>

          <section className="modal-section">
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={openConfigFile}
                disabled={opening}
              >
                {opening ? '打开中…' : '编辑 config.yaml (其它项)'}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void invoke('app:openDevTools', undefined);
                }}
                title="打开 Electron 开发者工具（分离窗口）"
              >
                打开 DevTools
              </button>
            </div>
            <p className="muted modal-footer">
              其他完整配置可在 config.yaml 中修改。
            </p>
            {openError && <p className="error-text">{openError}</p>}
          </section>
        </div>
      </div>
      {llmEditor && (
        <LlmEditorModal
          state={llmEditor}
          existing={llm.profiles}
          onChange={(draft) => setLlmEditor({ ...llmEditor, draft })}
          onSave={() => void saveEditor()}
          onCancel={closeEditor}
        />
      )}
    </div>
  );
}

function LlmEditorModal({
  state,
  existing,
  onChange,
  onSave,
  onCancel,
}: {
  state: { mode: 'add' | 'edit'; draft: LlmProfile };
  existing: LlmProfile[];
  onChange: (draft: LlmProfile) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { mode, draft } = state;
  const [keyVisible, setKeyVisible] = useState(false);
  // per-field touched：只有用户实际碰过（失焦）的字段才显示校验错误，
  // 避免刚打开就一片红。保存被点击时一次性把所有字段标 touched
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
  const errors = validateProfile(draft, existing);
  const showError = (k: keyof ProfileErrors): boolean => touched[k] && !!errors[k];
  const isValid = Object.keys(errors).length === 0;
  const anyTouched = Object.values(touched).some(Boolean);
  const update = <K extends keyof LlmProfile>(field: K, value: LlmProfile[K]): void => {
    onChange({ ...draft, [field]: value });
  };
  // Base URL placeholder：有默认 endpoint 时直接展示该 URL（用户看出 pr-agent
  // 实际会用到的地址）；没有默认值时给个示例 + 必填提示
  const baseUrlPlaceholder = providerMeta.defaultBaseUrl || 'https://your-endpoint.example.com/v1';
  const trySave = (): void => {
    if (!isValid) {
      // 点保存时把所有字段标 touched，一次性把所有问题暴露出来
      setTouched({ label: true, model: true, base_url: true, api_key: true });
      return;
    }
    onSave();
  };
  return (
    <div className="modal-backdrop modal-backdrop-nested" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>{mode === 'add' ? '新增 LLM 模型' : '编辑 LLM 模型'}</h3>
          <button className="btn" type="button" onClick={onCancel}>
            取消
          </button>
        </div>
        <div className="modal-body">
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
            <div className="modal-kv-key">
              Model <span className="settings-required">*</span>
            </div>
            <div className="modal-kv-val">
              <input
                type="text"
                className={`settings-input${showError('model') ? ' settings-input-error' : ''}`}
                value={draft.model}
                onChange={(e) => update('model', e.target.value)}
                onBlur={() => markTouched('model')}
                placeholder={providerMeta.modelExample}
              />
              {showError('model') && (
                <p className="settings-field-error">{errors.model}</p>
              )}
            </div>
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
              {showError('base_url') && (
                <p className="settings-field-error">{errors.base_url}</p>
              )}
            </div>
            <div className="modal-kv-key">
              API Key{providerMeta.needsKey && <span className="settings-required"> *</span>}
            </div>
            <div className="modal-kv-val">
              <div className="settings-secret-row">
                <input
                  type={keyVisible ? 'text' : 'password'}
                  className={`settings-input${
                    showError('api_key') ? ' settings-input-error' : ''
                  }`}
                  value={draft.api_key}
                  onChange={(e) => update('api_key', e.target.value)}
                  onBlur={() => markTouched('api_key')}
                  placeholder={providerMeta.needsKey ? 'sk-...' : '该 provider 无需密钥（留空）'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setKeyVisible((v) => !v)}
                >
                  {keyVisible ? '隐藏' : '显示'}
                </button>
              </div>
              {showError('api_key') && (
                <p className="settings-field-error">{errors.api_key}</p>
              )}
            </div>
          </div>
          <p className="muted modal-footer">{providerMeta.hint}</p>
          <div className="settings-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={trySave}
              disabled={anyTouched && !isValid}
              title={anyTouched && !isValid ? '请先填完必填项' : undefined}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
