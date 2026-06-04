import { useEffect, useState, type CSSProperties } from 'react';
import type { AppInfo, AppPaths, Config, LlmProfile, LlmProvider } from '@pr-pilot/shared';
import { invoke } from '../api';
import { ConfirmModal } from './ConfirmModal';
import { CloseIcon, FolderIcon, PencilIcon, TrashIcon } from './icons';

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

// 顺序：海外通用 (OpenAI / OpenAI 兼容 / Anthropic) → 国内三家 (DeepSeek / 阿里
// 百炼 / 火山方舟) → 本地 (Ollama)，方便用户按主流程扫读
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
    value: 'anthropic',
    label: 'Anthropic',
    hint: '模型用 anthropic/claude-3-5-sonnet 等带前缀的写法',
    modelExample: 'anthropic/claude-3-5-sonnet / anthropic/claude-3-haiku',
    defaultBaseUrl: 'https://api.anthropic.com',
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

// 轮询间隔档位（秒）：低值细（30s 一档）、高值粗（分钟级），梯度放大。滑块拖的是
// 档位索引而非秒数，从而实现非线性步长 + 离散刻度。
const POLLER_TIERS = [60, 90, 120, 180, 300, 600, 900];
/** 取最接近给定秒数的档位索引（配置值不在档位上时就近吸附） */
function nearestPollerIdx(seconds: number): number {
  let best = 0;
  for (let i = 1; i < POLLER_TIERS.length; i++) {
    if (Math.abs(POLLER_TIERS[i]! - seconds) < Math.abs(POLLER_TIERS[best]! - seconds)) best = i;
  }
  return best;
}

// 连接编辑用的扁平草稿（Connection 是嵌套的 auth/clone，拍平后表单好写），存盘前还原。
type ConnEntry = Config['connections'][number];
type ConnDraft = {
  id: string;
  display_name: string;
  base_url: string;
  token: string;
  protocol: 'pat' | 'ssh';
};
function toConnDraft(c: ConnEntry): ConnDraft {
  return {
    id: c.id,
    display_name: c.display_name,
    base_url: c.base_url,
    token: c.auth.token,
    protocol: c.clone.protocol,
  };
}
function fromConnDraft(d: ConnDraft): ConnEntry {
  return {
    id: d.id,
    kind: 'bitbucket-server',
    base_url: d.base_url.trim(),
    display_name: d.display_name.trim() || d.base_url.trim(),
    auth: { type: 'pat', token: d.token },
    clone: { protocol: d.protocol },
  };
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

  // 草稿 → 整体保存：所有编辑只改本地 state，点底栏"保存"才整体写盘 + 生效
  const [reposDirInput, setReposDirInput] = useState(config.workspace.repos_dir);
  const [rules, setRules] = useState<Config['rules']>(config.rules);
  const [rulesDirInput, setRulesDirInput] = useState(config.rules.dir);
  const [pollerInput, setPollerInput] = useState(String(config.poller.interval_seconds));
  const [llm, setLlm] = useState<Config['llm']>(config.llm);
  const [llmEditor, setLlmEditor] = useState<{ mode: 'add' | 'edit'; draft: LlmProfile } | null>(
    null,
  );

  // 保存基线：保存成功后更新，用于 changed 判定（禁用保存按钮）
  const [base, setBase] = useState(() => ({
    reposDir: config.workspace.repos_dir,
    rulesDir: config.rules.dir,
    rulesEnabled: config.rules.enabled,
    poller: config.poller.interval_seconds,
    llm: config.llm,
    connections: config.connections,
    activeConnId: config.active_connection_id,
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const pollerIdx = nearestPollerIdx(Number.parseInt(pollerInput, 10) || 300);
  const pollerFillPct = (pollerIdx / (POLLER_TIERS.length - 1)) * 100;

  // 连接 / LLM 编辑：改本地 state + 自动写入 config.yaml（防丢失），但不应用到运行时
  //（不 reconfigure；重启或点底栏「保存」才生效）。其余配置（规则/轮询/缓存）仍纯草稿。
  const autosaveDraft = (nextConnections: Config['connections'], activeId: string, nextLlm: Config['llm']): void => {
    void invoke('config:autosaveDraft', {
      connections: nextConnections,
      active_connection_id: activeId,
      llm: nextLlm,
    }).catch(() => {
      /* 自动保存失败不打断编辑；点底栏保存时会再写一次 */
    });
  };
  const persistLlm = (next: Config['llm']): void => {
    setLlm(next);
    setSaved(false);
    autosaveDraft(connections, activeConnId, next);
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

  // ── 连接：多条可配置 + 单选启用；编辑只改本地 state，整体保存才写盘 + 热重建 ──
  const [connections, setConnections] = useState<Config['connections']>(config.connections);
  const [activeConnId, setActiveConnId] = useState<string>(config.active_connection_id);
  const [connEditor, setConnEditor] = useState<{ mode: 'add' | 'edit'; draft: ConnDraft } | null>(
    null,
  );
  const [connDeleteId, setConnDeleteId] = useState<string | null>(null);

  const persistConnections = (next: Config['connections'], activeId: string): void => {
    setConnections(next);
    setActiveConnId(activeId);
    setSaved(false);
    autosaveDraft(next, activeId, llm);
  };
  const openAddConn = (): void => {
    setConnEditor({
      mode: 'add',
      draft: { id: newProfileId(), display_name: '', base_url: '', token: '', protocol: 'pat' },
    });
  };
  const openEditConn = (id: string): void => {
    const c = connections.find((x) => x.id === id);
    if (c) setConnEditor({ mode: 'edit', draft: toConnDraft(c) });
  };
  const saveConnEditor = async (): Promise<void> => {
    if (!connEditor) return;
    const { mode, draft } = connEditor;
    const conn = fromConnDraft(draft);
    const next =
      mode === 'add' ? [...connections, conn] : connections.map((c) => (c.id === conn.id ? conn : c));
    // 新增首条自动设为启用
    const activeId = mode === 'add' && !activeConnId ? conn.id : activeConnId;
    await persistConnections(next, activeId);
    setConnEditor(null);
  };
  const deleteConn = async (id: string): Promise<void> => {
    const next = connections.filter((c) => c.id !== id);
    // 删的是当前启用 → 启用回退到剩下第一条（无则空串，不轮询任何连接）
    const activeId = activeConnId === id ? (next[0]?.id ?? '') : activeConnId;
    await persistConnections(next, activeId);
  };
  const setActiveConn = (id: string): void => {
    if (activeConnId === id) return;
    persistConnections(connections, id);
  };

  // ── 变更检测（对比基线）+ 整体保存（仅写有变更的部分，全成功后更新基线）──
  const reposDirChanged = reposDirInput.trim() !== base.reposDir;
  const rulesChanged =
    rulesDirInput.trim() !== base.rulesDir || rules.enabled !== base.rulesEnabled;
  const pollerChanged = pollerInput.trim() !== String(base.poller);
  const llmChanged = JSON.stringify(llm) !== JSON.stringify(base.llm);
  const connectionsChanged =
    activeConnId !== base.activeConnId ||
    JSON.stringify(connections) !== JSON.stringify(base.connections);
  const anyChanged =
    reposDirChanged || rulesChanged || pollerChanged || llmChanged || connectionsChanged;

  const saveAll = async (): Promise<void> => {
    if (saving || !anyChanged) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      if (pollerChanged) {
        const n = Number.parseInt(pollerInput, 10);
        if (!Number.isFinite(n) || n < 60 || n > 900) throw new Error('轮询间隔需 60~900 秒整数');
        await invoke('config:setPoller', { interval_seconds: n });
      }
      if (rulesChanged) {
        await invoke('config:setRules', {
          rules: { dir: rulesDirInput.trim(), enabled: rules.enabled },
        });
      }
      if (llmChanged) {
        await invoke('config:setLlm', { llm });
        onLlmChange?.(llm);
      }
      if (connectionsChanged) {
        await invoke('config:setConnections', { connections, active_connection_id: activeConnId });
      }
      if (reposDirChanged && reposDirInput.trim()) {
        await invoke('config:setReposDir', { reposDir: reposDirInput.trim() });
      }
      setBase({
        reposDir: reposDirInput.trim(),
        rulesDir: rulesDirInput.trim(),
        rulesEnabled: rules.enabled,
        poller: Number.parseInt(pollerInput, 10),
        llm,
        connections,
        activeConnId,
      });
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>设置</h3>
          <button
            className="icon-btn modal-close"
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">
          <section className="modal-section">
            <div className="modal-section-head">
              <h4>连接</h4>
              <button type="button" className="btn btn-primary btn-sm" onClick={openAddConn}>
                + 添加连接
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              同时只启用一个连接。
            </p>
            {connections.length === 0 ? (
              <p className="muted">尚未配置；添加一条 Bitbucket Server 连接以开始。</p>
            ) : (
              <div className="llm-profile-list">
                {connections.map((c) => {
                  const isActive = c.id === activeConnId;
                  return (
                    <div key={c.id} className={`llm-profile-row${isActive ? ' active' : ''}`}>
                      <label className="llm-profile-active">
                        <input
                          type="radio"
                          name="conn-active"
                          checked={isActive}
                          onChange={() => void setActiveConn(c.id)}
                          aria-label="启用该连接"
                        />
                      </label>
                      <div className="llm-profile-meta">
                        <div className="llm-profile-title">{c.display_name || c.id}</div>
                        <div className="muted llm-profile-sub">
                          {c.base_url} · clone via {c.clone.protocol === 'ssh' ? 'SSH' : 'PAT'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-primary"
                        onClick={() => openEditConn(c.id)}
                        title="编辑"
                        aria-label="编辑"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-danger"
                        onClick={() => setConnDeleteId(c.id)}
                        title="删除该连接"
                        aria-label="删除"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="modal-section">
            <h4>轮询</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              自动检查 PR 的间隔，60~900 秒整数。
            </p>
            <div className="settings-edit-row" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="range"
                  className="settings-range"
                  style={{ width: '100%', '--range-fill': `${pollerFillPct}%` } as CSSProperties}
                  min={0}
                  max={POLLER_TIERS.length - 1}
                  step={1}
                  value={pollerIdx}
                  onChange={(e) => {
                    const idx = Number.parseInt(e.target.value, 10);
                    setPollerInput(String(POLLER_TIERS[idx]));
                    setSaved(false);
                  }}
                  aria-label="轮询间隔档位"
                />
                {/* 档位刻度：按 thumb 实际停靠位置绝对定位（thumb 宽 12px，两端内缩 6px），
                    translateX(-50%) 居中对齐；当前档位高亮 */}
                <div className="settings-range-ticks">
                  {POLLER_TIERS.map((t, i) => {
                    const frac = i / (POLLER_TIERS.length - 1);
                    return (
                      <span
                        key={t}
                        className={i === pollerIdx ? 'active' : undefined}
                        style={{ left: `calc(${frac * 100}% + ${6 - frac * 12}px)` }}
                      >
                        {t}
                      </span>
                    );
                  })}
                </div>
              </div>
              <span
                className="muted"
                style={{ minWidth: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
              >
                {pollerInput} 秒
              </span>
            </div>
          </section>

          <section className="modal-section">
            <div className="modal-section-head">
              <h4>LLM 模型</h4>
              <button type="button" className="btn btn-primary btn-sm" onClick={openAddProfile}>
                + 添加配置
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              选择活跃配置决定 PR Agent 调用哪个模型。
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
                        className="btn btn-sm btn-icon btn-icon-primary"
                        onClick={() => openEditProfile(p.id)}
                        title="编辑"
                        aria-label="编辑"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-danger"
                        onClick={() => void deleteProfile(p.id)}
                        title="删除该配置"
                        aria-label="删除"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
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
                  setSaved(false);
                }}
                placeholder="可选；如 ~/code/team-pr-rules"
              />
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => {
                  void (async () => {
                    const r = await invoke('dialog:pickDirectory', {
                      defaultPath: rulesDirInput.trim() || paths.appDir,
                      title: '选择规则目录',
                    });
                    if (r.path) {
                      setRulesDirInput(r.path);
                      setSaved(false);
                    }
                  })();
                }}
                title="选择目录"
                aria-label="选择目录"
              >
                <FolderIcon />
              </button>
            </div>
            <label className="settings-secret-row" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={rules.enabled}
                onChange={(e) => {
                  setRules((r) => ({ ...r, enabled: e.target.checked }));
                  setSaved(false);
                }}
                aria-label="启用规则"
              />
              <span className="muted">启用规则</span>
            </label>
          </section>

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
            <h4>缓存目录</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              本地仓库镜像 + worktree 的存放位置，可重建的缓存。
            </p>
            <div className="modal-kv">
              <div className="modal-kv-key">当前目录</div>
              <div className="modal-kv-val">{paths.reposDir}</div>
              <div className="modal-kv-key">缓存占用</div>
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
                  setSaved(false);
                }}
                placeholder="~/.pr-pilot/repos"
              />
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => {
                  void (async () => {
                    const r = await invoke('dialog:pickDirectory', {
                      defaultPath: reposDirInput.trim() || paths.reposDir,
                      title: '选择缓存目录',
                    });
                    if (r.path) {
                      setReposDirInput(r.path);
                      setSaved(false);
                    }
                  })();
                }}
                title="选择目录"
                aria-label="选择目录"
              >
                <FolderIcon />
              </button>
            </div>
            <p className="muted modal-footer">改缓存目录需重启应用生效；原目录内容不会自动迁移。</p>
          </section>

          <section className="modal-section">
            <h4>运行环境</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">应用版本</div>
              <div className="modal-kv-val">{info.appVersion}</div>
              <div className="modal-kv-key">Electron</div>
              <div className="modal-kv-val">{info.electronVersion}</div>
              <div className="modal-kv-key">Node</div>
              <div className="modal-kv-val">{info.nodeVersion}</div>
              <div className="modal-kv-key">平台</div>
              <div className="modal-kv-val">{info.platform}</div>
            </div>
            <div className="settings-actions" style={{ marginTop: 10 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void invoke('app:openDevTools', undefined)}
                title="打开 Electron 开发者工具（分离窗口）"
              >
                打开 DevTools
              </button>
            </div>
          </section>

        </div>
        <div className="modal-footer-bar">
          <div className="modal-footer-left">
            <button
              className="btn"
              type="button"
              onClick={() => void openConfigFile()}
              disabled={opening}
            >
              {opening ? '打开中…' : '编辑 config.yaml'}
            </button>
          </div>
          <div className="modal-footer-right">
            {(saveError ?? openError) && (
              <span className="error-text">{saveError ?? openError}</span>
            )}
            {saved && !anyChanged && <span className="muted">已保存</span>}
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void saveAll()}
              disabled={!anyChanged || saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
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
      {connEditor && (
        <ConnectionEditorModal
          state={connEditor}
          onChange={(draft) => setConnEditor({ ...connEditor, draft })}
          onSave={() => void saveConnEditor()}
          onCancel={() => setConnEditor(null)}
        />
      )}
      {connDeleteId && (
        <ConfirmModal
          title="删除连接"
          message={`确定删除连接「${
            connections.find((c) => c.id === connDeleteId)?.display_name || connDeleteId
          }」？点底栏「保存」后生效。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            deleteConn(connDeleteId);
            setConnDeleteId(null);
          }}
          onCancel={() => setConnDeleteId(null)}
        />
      )}
    </div>
  );
}

function ConnectionEditorModal({
  state,
  onChange,
  onSave,
  onCancel,
}: {
  state: { mode: 'add' | 'edit'; draft: ConnDraft };
  onChange: (draft: ConnDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { mode, draft } = state;
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const update = <K extends keyof ConnDraft>(field: K, value: ConnDraft[K]): void => {
    onChange({ ...draft, [field]: value });
    setTestResult(null); // 改字段清掉旧测试结果，避免误导
  };
  const urlValid = /^https?:\/\/.+/i.test(draft.base_url.trim());
  const canTest = urlValid && draft.token.trim() !== '';
  const canSave = draft.display_name.trim() !== '' && canTest;
  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await invoke('config:testConnection', {
        base_url: draft.base_url.trim(),
        token: draft.token,
      });
      setTestResult(
        r.ok
          ? {
              ok: true,
              text: `连接成功${r.user ? ` · ${r.user.displayName}` : ''}${
                r.serverVersion ? ` · v${r.serverVersion}` : ''
              }`,
            }
          : { ok: false, text: r.reason ?? '连接失败' },
      );
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="modal-backdrop modal-backdrop-nested" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>{mode === 'add' ? '新增连接' : '编辑连接'}</h3>
        </div>
        <div className="modal-body">
          <div className="modal-kv">
            <div className="modal-kv-key">
              名称 <span className="settings-required">*</span>
            </div>
            <div className="modal-kv-val">
              <input
                type="text"
                className="settings-input"
                value={draft.display_name}
                onChange={(e) => update('display_name', e.target.value)}
                placeholder="如 公司 Bitbucket"
                autoFocus
                maxLength={48}
              />
            </div>
            <div className="modal-kv-key">
              Base URL <span className="settings-required">*</span>
            </div>
            <div className="modal-kv-val">
              <input
                type="text"
                className={`settings-input${draft.base_url && !urlValid ? ' settings-input-error' : ''}`}
                value={draft.base_url}
                onChange={(e) => update('base_url', e.target.value)}
                placeholder="https://bitbucket.example.com"
              />
            </div>
            <div className="modal-kv-key">
              访问令牌 (PAT) <span className="settings-required">*</span>
            </div>
            <div className="modal-kv-val">
              <div className="settings-secret-row">
                <input
                  type={tokenVisible ? 'text' : 'password'}
                  className="settings-input"
                  value={draft.token}
                  onChange={(e) => update('token', e.target.value)}
                  placeholder="BBS HTTP access token"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setTokenVisible((v) => !v)}
                >
                  {tokenVisible ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div className="modal-kv-key">Clone 协议</div>
            <div className="modal-kv-val">
              <select
                className="settings-input"
                value={draft.protocol}
                onChange={(e) => update('protocol', e.target.value as 'pat' | 'ssh')}
              >
                <option value="pat">HTTPS (PAT)</option>
                <option value="ssh">SSH (走系统 ssh config)</option>
              </select>
            </div>
          </div>
          {/* 测试连接 + 取消/保存 同一行：测试在左、决断按钮在右；全用 .btn 同高，
              align-items:center 对齐，.btn 自带 inline-flex 居中文字 */}
          <div
            className="settings-actions"
            style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}
            >
              <button
                type="button"
                className="btn"
                onClick={() => void runTest()}
                disabled={!canTest || testing}
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
              {testResult && (
                <span
                  className={testResult.ok ? undefined : 'error-text'}
                  style={testResult.ok ? { color: '#3fb950' } : undefined}
                >
                  {testResult.text}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={onCancel}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onSave}
                disabled={!canSave}
                title={!canSave ? '请填完名称 / Base URL / Token' : undefined}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
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
          <div className="settings-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
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
