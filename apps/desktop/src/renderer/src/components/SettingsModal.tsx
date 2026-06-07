import { useEffect, useState, type CSSProperties } from 'react';
import type { AppInfo, AppPaths, Config, LlmProfile } from '@meebox/shared';
import { invoke } from '../api';
import { ConfirmModal } from './ConfirmModal';
import {
  ConnectionForm,
  connDraftCanSave,
  fromConnDraft,
  toConnDraft,
  type ConnDraft,
} from './ConnectionForm';
import {
  LlmProfileForm,
  newProfileId,
  providerLabel,
  validateProfile,
} from './LlmProfileForm';
import { CloseIcon, EyeIcon, EyeOffIcon, FolderIcon, PencilIcon, TrashIcon } from './icons';

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** LLM 配置改动后通知父级同步状态（StatusBar chip 等） */
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  onClose: () => void;
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

export function SettingsModal({
  info,
  paths,
  config,
  onLlmChange,
  onProxyChange,
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
  const [proxy, setProxy] = useState<Config['proxy']>(config.proxy);
  // 代理在独立模态框里编辑：null=关闭，非 null=正在编辑的草稿；保存回 proxy，底栏「保存」才写盘。
  const [proxyEditor, setProxyEditor] = useState<Config['proxy'] | null>(null);

  // 保存基线：保存成功后更新，用于 changed 判定（禁用保存按钮）
  const [base, setBase] = useState(() => ({
    reposDir: config.workspace.repos_dir,
    rulesDir: config.rules.dir,
    rulesEnabled: config.rules.enabled,
    poller: config.poller.interval_seconds,
    llm: config.llm,
    proxy: config.proxy,
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
    // 提升到 App 的 boot.config.llm：重开模态框时 SettingsModal 用最新 prop 重建本地
    // state，新增/编辑的渠道不丢。onLlmChange 只改渲染层 state、不调 config:setLlm，
    // 所以是"写入(磁盘+渲染层)但不启用"——运行时仍用旧 active 模型，直到底栏「保存」
    // 走 config:setLlm 或显式切换启用渠道才真正应用。
    onLlmChange?.(next);
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
  const proxyChanged = JSON.stringify(proxy) !== JSON.stringify(base.proxy);
  const connectionsChanged =
    activeConnId !== base.activeConnId ||
    JSON.stringify(connections) !== JSON.stringify(base.connections);
  const anyChanged =
    reposDirChanged ||
    rulesChanged ||
    pollerChanged ||
    llmChanged ||
    proxyChanged ||
    connectionsChanged;

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
      if (proxyChanged) {
        await invoke('config:setProxy', { proxy });
        // 同步到 App 的 boot.config.proxy：重开设置面板时 SettingsModal 用最新 prop
        // 重建本地 state，才能正确回显已保存的代理配置（否则读到启动时的旧值）。
        onProxyChange?.(proxy);
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
        proxy,
        connections,
        activeConnId,
      });
      setSaved(true);
      // 保存成功后自动关闭设置面板（失败则保持打开并展示 saveError）
      onClose();
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
            <div className="modal-section-head">
              <h4>网络代理</h4>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setProxyEditor(proxy)}
              >
                配置
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {proxy.enabled && proxy.host ? `已启用 · ${proxy.host}:${proxy.port}` : '未启用'}
              。开启后 LLM / 代码平台 / git(HTTPS) 经 HTTP 代理，本地地址直连。
            </p>
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
                placeholder="~/.code-meeseeks/repos"
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
      {proxyEditor && (
        <ProxyEditorModal
          draft={proxyEditor}
          onChange={setProxyEditor}
          onSave={() => {
            setProxy(proxyEditor);
            setProxyEditor(null);
            setSaved(false);
          }}
          onCancel={() => setProxyEditor(null)}
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
  const canSave = connDraftCanSave(draft);
  return (
    // 二层模态：背景点击只关本层，stopPropagation 防冒泡到设置主模态的 onClose（否则会连设置一起关）
    <div
      className="modal-backdrop modal-backdrop-nested"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>{mode === 'add' ? '新增连接' : '编辑连接'}</h3>
        </div>
        <div className="modal-body">
          <ConnectionForm draft={draft} onChange={onChange} />
          <div
            className="settings-actions"
            style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
          >
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
  );
}

function ProxyEditorModal({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Config['proxy'];
  onChange: (next: Config['proxy']) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [test, setTest] = useState<{
    testing: boolean;
    result: { ok: boolean; reason?: string } | null;
  }>({ testing: false, result: null });
  const [pwVisible, setPwVisible] = useState(false);
  // 改任意字段都清掉上次测试结果（避免误导）
  const patch = (p: Partial<Config['proxy']>): void => {
    onChange({ ...draft, ...p });
    setTest({ testing: false, result: null });
  };
  return (
    // 二层模态：背景点击只关本层，stopPropagation 防冒泡到设置主模态的 onClose（否则会连设置一起关）
    <div
      className="modal-backdrop modal-backdrop-nested"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="modal"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="modal-header">
          <h3>网络代理</h3>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ margin: '0 0 10px' }}>
            HTTP 代理（出站）。开启后 LLM 调用、代码平台、git(HTTPS) 统一经代理，本地地址直连。
          </p>
          <label className="settings-secret-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              aria-label="启用代理"
            />
            <span className="muted">启用代理</span>
          </label>
          {draft.enabled && (
            <>
              {/* 字段名放输入框前（modal-kv 网格）；用户名 / 密码分上下两行，均可选 */}
              <div className="modal-kv" style={{ marginTop: 10, alignItems: 'center' }}>
                <div className="modal-kv-key">地址</div>
                <div className="modal-kv-val">
                  <input
                    type="text"
                    className="settings-input"
                    value={draft.host}
                    onChange={(e) => patch({ host: e.target.value.trim() })}
                    placeholder="如 127.0.0.1"
                    aria-label="代理地址"
                  />
                </div>
                <div className="modal-kv-key">端口</div>
                <div className="modal-kv-val">
                  <input
                    type="number"
                    className="settings-input"
                    value={draft.port}
                    min={1}
                    max={65535}
                    onChange={(e) => patch({ port: Number.parseInt(e.target.value, 10) || 0 })}
                    aria-label="代理端口"
                  />
                </div>
                <div className="modal-kv-key">用户名</div>
                <div className="modal-kv-val">
                  <input
                    type="text"
                    className="settings-input"
                    value={draft.username}
                    onChange={(e) => patch({ username: e.target.value })}
                    placeholder="可选（Basic Auth）"
                    aria-label="代理用户名"
                    autoComplete="off"
                  />
                </div>
                <div className="modal-kv-key">密码</div>
                <div className="modal-kv-val">
                  <div className="settings-secret-row">
                    <input
                      type={pwVisible ? 'text' : 'password'}
                      className="settings-input"
                      value={draft.password}
                      onChange={(e) => patch({ password: e.target.value })}
                      placeholder="可选"
                      aria-label="代理密码"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      onClick={() => setPwVisible((v) => !v)}
                      title={pwVisible ? '隐藏' : '显示'}
                      aria-label={pwVisible ? '隐藏' : '显示'}
                    >
                      {pwVisible ? <EyeIcon /> : <EyeOffIcon />}
                    </button>
                  </div>
                </div>
              </div>
              <div
                className="settings-edit-row"
                style={{ marginTop: 10, alignItems: 'center', gap: 10 }}
              >
                <button
                  type="button"
                  className="btn"
                  disabled={test.testing || !draft.host}
                  onClick={() => {
                    void (async () => {
                      setTest({ testing: true, result: null });
                      try {
                        const r = await invoke('config:testProxy', { proxy: draft });
                        setTest({ testing: false, result: r });
                      } catch (e) {
                        setTest({
                          testing: false,
                          result: { ok: false, reason: e instanceof Error ? e.message : String(e) },
                        });
                      }
                    })();
                  }}
                >
                  {test.testing ? '测试中…' : '测试连通'}
                </button>
                {test.result &&
                  (test.result.ok ? (
                    <span className="muted" style={{ color: '#16825d' }}>
                      ✓ 代理可用
                    </span>
                  ) : (
                    <span className="error-text">✗ {test.result.reason ?? '失败'}</span>
                  ))}
              </div>
            </>
          )}
          <div
            className="settings-actions"
            style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={draft.enabled && !draft.host}
              title={draft.enabled && !draft.host ? '请填代理地址' : undefined}
            >
              确定
            </button>
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
  // 点保存才把所有必填项暴露出来（LlmProfileForm 内部按 touched 渐进显示）
  const [forceShowErrors, setForceShowErrors] = useState(false);
  const isValid = Object.keys(validateProfile(draft, existing)).length === 0;
  const trySave = (): void => {
    if (!isValid) {
      setForceShowErrors(true);
      return;
    }
    onSave();
  };
  return (
    // 二层模态：背景点击只关本层，stopPropagation 防冒泡到设置主模态的 onClose（否则会连设置一起关）
    <div
      className="modal-backdrop modal-backdrop-nested"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-header">
          <h3>{mode === 'add' ? '新增 LLM 模型' : '编辑 LLM 模型'}</h3>
        </div>
        <div className="modal-body">
          <LlmProfileForm
            draft={draft}
            existing={existing}
            onChange={onChange}
            forceShowErrors={forceShowErrors}
          />
          <div className="settings-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={trySave}
              disabled={forceShowErrors && !isValid}
              title={forceShowErrors && !isValid ? '请先填完必填项' : undefined}
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
