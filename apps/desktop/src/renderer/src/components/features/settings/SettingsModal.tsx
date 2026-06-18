import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LANGUAGE_OPTIONS,
  type AppInfo,
  type AppPaths,
  type Config,
  type LlmProfile,
  type SupportedLanguage,
  type UpdateCheckResult,
} from '@meebox/shared';
import { invoke } from '../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../i18n';
import { ConfirmModal } from '../../common/ConfirmModal';
import {
  ConnectionForm,
  connDraftCanSave,
  fromConnDraft,
  toConnDraft,
  type ConnDraft,
} from './ConnectionForm';
import { LlmProfileForm, newProfileId, providerLabel, validateProfile } from './LlmProfileForm';
import {
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  GitHubMarkIcon,
  IssueIcon,
  PencilIcon,
  TagIcon,
  TrashIcon,
} from '../../common/icons';
import { LlmProviderIcon } from '../../common/LlmProviderIcon';
import { PLATFORM_META } from '../../common/PlatformIcon';

interface SettingsModalProps {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  /** LLM 配置改动后通知父级同步状态（StatusBar chip 等） */
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  /** UI 语言即时切换后通知父级同步 boot.config.language（与写盘/实时切换解耦的状态同步） */
  onLanguageChange?: (language: SupportedLanguage) => void;
  /**
   * 连接改动（含切换活动连接）保存成功后通知父级。父级需重拉 config + 连接摘要 + PR 列表：
   * 活动连接变化后，main 端 app:connections 只返回新活动连接的摘要、prs:list 只返回其 PR，
   * 不刷新的话 App 的 boot.connections / 列表会过期（丢 capabilities/user、PR 对不上）。
   */
  onConnectionsChange?: () => void | Promise<void>;
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
  onLanguageChange,
  onConnectionsChange,
  onClose,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // 草稿 → 整体保存：所有编辑只改本地 state，点底栏"保存"才整体写盘 + 生效
  const [reposDirInput, setReposDirInput] = useState(config.workspace.repos_dir);
  // Agent 其余字段（max_steps / summary_max_chars / autopilot）在 UI 不编辑，仅持有以便保存时
  // 原样回传、不被覆盖成默认值；只有目录经 agentDirInput 可编辑。
  const [agent] = useState<Config['agent']>(config.agent);
  const [agentDirInput, setAgentDirInput] = useState(config.agent.dir);
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
    agentDir: config.agent.dir,
    poller: config.poller.interval_seconds,
    llm: config.llm,
    proxy: config.proxy,
    connections: config.connections,
    activeConnId: config.active_connection_id,
  }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // UI 语言：即时生效项（不走全局保存）。下拉值取「当前生效语言」(config.language 经
  // resolveUiLanguage 解析，空配置 → OS 偏好)。选择后立即写盘 + 主进程/渲染层同步切换。
  const [language, setLanguage] = useState<SupportedLanguage>(() =>
    resolveUiLanguage(config.language),
  );
  const handleLanguageChange = (next: SupportedLanguage): void => {
    if (next === language) return;
    setLanguage(next);
    void i18n.changeLanguage(next); // 渲染层实时切换
    persistLanguage(next); // localStorage 缓存，下次启动同步命中
    onLanguageChange?.(next); // 同步父级 boot.config.language
    invoke('config:setLanguage', { language: next }).catch((e: unknown) => {
      // 写盘 / 主进程切换失败不回滚 UI（已切），仅提示；下次启动按 localStorage 兜底
      setSaveError(e instanceof Error ? e.message : String(e));
    });
  };

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
  const autosaveDraft = (
    nextConnections: Config['connections'],
    activeId: string,
    nextLlm: Config['llm'],
  ): void => {
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
      draft: {
        id: newProfileId(),
        kind: 'github',
        display_name: '',
        base_url: '',
        token: '',
        protocol: 'pat',
      },
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
      mode === 'add'
        ? [...connections, conn]
        : connections.map((c) => (c.id === conn.id ? conn : c));
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
  const agentChanged = agentDirInput.trim() !== base.agentDir;
  const pollerChanged = pollerInput.trim() !== String(base.poller);
  const llmChanged = JSON.stringify(llm) !== JSON.stringify(base.llm);
  const proxyChanged = JSON.stringify(proxy) !== JSON.stringify(base.proxy);
  const connectionsChanged =
    activeConnId !== base.activeConnId ||
    JSON.stringify(connections) !== JSON.stringify(base.connections);
  const anyChanged =
    reposDirChanged ||
    agentChanged ||
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
        if (!Number.isFinite(n) || n < 60 || n > 900)
          throw new Error(t('settings.pollerRangeError'));
        await invoke('config:setPoller', { interval_seconds: n });
      }
      if (agentChanged) {
        // 仅 UI 编辑 dir；其余字段（max_steps / summary_max_chars / autopilot）从已加载的
        // config 原样保留，避免被覆盖成默认值。
        await invoke('config:setAgent', {
          agent: { ...agent, dir: agentDirInput.trim() },
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
        await onConnectionsChange?.();
      }
      if (reposDirChanged && reposDirInput.trim()) {
        await invoke('config:setReposDir', { reposDir: reposDirInput.trim() });
      }
      setBase({
        reposDir: reposDirInput.trim(),
        agentDir: agentDirInput.trim(),
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
          <h3>{t('settings.title')}</h3>
          <button
            className="icon-btn modal-close"
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">
          {/* 界面语言：即时生效项，放在最前。固定宽度下拉靠右（标题两端对齐）；选项用各
              语言自身的 endonym，不随 UI 语言翻译。 */}
          <section className="modal-section">
            <div className="modal-section-head">
              <h4>{t('settings.languageTitle')}</h4>
              <select
                className="settings-input settings-language-select"
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as SupportedLanguage)}
                aria-label={t('settings.languageTitle')}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.endonym}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {t('settings.languageHint')}
            </p>
          </section>

          <section className="modal-section">
            <div className="modal-section-head">
              <h4>{t('settings.connectionsTitle')}</h4>
              <button type="button" className="btn btn-primary btn-sm" onClick={openAddConn}>
                {t('settings.addConnection')}
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {t('settings.connectionsHint')}
            </p>
            {connections.length === 0 ? (
              <p className="muted">{t('settings.connectionsEmpty')}</p>
            ) : (
              <div className="llm-profile-list">
                {connections.map((c) => {
                  const isActive = c.id === activeConnId;
                  const platformMeta = PLATFORM_META.find((m) => m.kind === c.kind);
                  return (
                    <div key={c.id} className={`llm-profile-row${isActive ? ' active' : ''}`}>
                      <label className="llm-profile-active">
                        <input
                          type="radio"
                          name="conn-active"
                          checked={isActive}
                          onChange={() => void setActiveConn(c.id)}
                          aria-label={t('settings.enableConnectionAria')}
                        />
                      </label>
                      {platformMeta && (
                        <span className="llm-profile-icon" title={platformMeta.label}>
                          <platformMeta.Icon size={20} />
                        </span>
                      )}
                      <div className="llm-profile-meta">
                        <div className="llm-profile-title">
                          <span className="llm-profile-title-text">{c.display_name || c.id}</span>
                        </div>
                        <div className="muted llm-profile-sub">
                          {c.base_url} · clone via {c.clone.protocol === 'ssh' ? 'SSH' : 'PAT'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-primary"
                        onClick={() => openEditConn(c.id)}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-danger"
                        onClick={() => setConnDeleteId(c.id)}
                        title={t('settings.deleteConnectionTitle')}
                        aria-label={t('common.delete')}
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
            <h4>{t('settings.pollerTitle')}</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {t('settings.pollerHint')}
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
                  aria-label={t('settings.pollerSliderAria')}
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
                {t('settings.pollerSeconds', { n: pollerInput })}
              </span>
            </div>
          </section>

          <section className="modal-section">
            <div className="modal-section-head">
              <h4>{t('settings.llmTitle')}</h4>
              <button type="button" className="btn btn-primary btn-sm" onClick={openAddProfile}>
                {t('settings.addLlmProfile')}
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {t('settings.llmHint')}
            </p>
            {llm.profiles.length === 0 ? (
              <p className="muted">{t('settings.llmEmpty')}</p>
            ) : (
              <div className="llm-profile-list">
                {llm.profiles.map((p) => {
                  const isActive = p.id === llm.active_id;
                  const titleText =
                    p.label || t('settings.llmProfileFallback', { id: p.id.slice(0, 4) });
                  const isCli = p.provider === 'cli';
                  return (
                    <div key={p.id} className={`llm-profile-row${isActive ? ' active' : ''}`}>
                      <label className="llm-profile-active">
                        <input
                          type="radio"
                          name="llm-active"
                          checked={isActive}
                          onChange={() => void setActive(p.id)}
                          aria-label={t('settings.setActiveLlmAria')}
                        />
                      </label>
                      <span className="llm-profile-icon" title={providerLabel(p.provider)}>
                        <LlmProviderIcon provider={p.provider} size={20} />
                      </span>
                      <div className="llm-profile-meta">
                        <div className="llm-profile-title">
                          <span className="llm-profile-title-text">{titleText}</span>
                          {isCli && (
                            <span className="badge-experimental" title={t('settings.cliExperimentalHint')}>
                              {t('settings.experimental')}
                            </span>
                          )}
                        </div>
                        <div className="muted llm-profile-sub">
                          {providerLabel(p.provider)}
                          {p.model ? ` · ${p.model}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-primary"
                        onClick={() => openEditProfile(p.id)}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon btn-icon-danger"
                        onClick={() => void deleteProfile(p.id)}
                        title={t('settings.deleteLlmProfileTitle')}
                        aria-label={t('common.delete')}
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
              <div className="modal-section-head-title">
                <h4>{t('settings.proxyTitle')}</h4>
                {/* 启用状态用 chip 表达（绿=已启用/灰=未启用），与应用其它状态视觉一致；
                    地址不在此展示，详情见「配置」弹窗。 */}
                <span
                  className={`settings-status-chip ${
                    proxy.enabled && proxy.host ? 'is-on' : 'is-off'
                  }`}
                >
                  {proxy.enabled && proxy.host
                    ? t('settings.proxyEnabledStatus')
                    : t('settings.proxyDisabledStatus')}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setProxyEditor(proxy)}
              >
                {t('settings.configure')}
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {t('settings.proxyStatusHint')}
            </p>
          </section>

          <section className="modal-section">
            {/* 标题行：左侧标题 + 右侧蓝色「打开当前目录」按钮（在系统文件管理器打开生效的 Agent 目录，
                便于直接查看 / 编辑文件）。放在标题行而非配置行，避免与下方的目录选择按钮混淆。 */}
            <div className="modal-section-head">
              <h4>{t('settings.agentDirTitle')}</h4>
              {/* 文案按钮（非图标）：与下方的目录「选择」图标按钮区分开，避免混淆。尺寸与其它区块标题行
                  的操作按钮（添加连接 / 添加配置 / 代理配置）一致，统一用 btn-sm。 */}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void invoke('app:openAgentDir', undefined)}
                title={t('settings.openAgentDir')}
              >
                {t('settings.openAgentDir')}
              </button>
            </div>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {t('settings.agentDirHint')}
            </p>
            <div className="settings-edit-row">
              <input
                type="text"
                className="settings-input"
                value={agentDirInput}
                onChange={(e) => {
                  setAgentDirInput(e.target.value);
                  setSaved(false);
                }}
                placeholder={t('settings.agentDirPlaceholder')}
              />
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => {
                  void (async () => {
                    const r = await invoke('dialog:pickDirectory', {
                      defaultPath: agentDirInput.trim() || paths.appDir,
                      title: t('settings.pickAgentDirTitle'),
                    });
                    if (r.path) {
                      setAgentDirInput(r.path);
                      setSaved(false);
                    }
                  })();
                }}
                title={t('settings.pickDirectory')}
                aria-label={t('settings.pickDirectory')}
              >
                <FolderIcon />
              </button>
            </div>
          </section>

          <section className="modal-section">
            <h4>{t('settings.workDirTitle')}</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">{t('settings.appRoot')}</div>
              <div className="modal-kv-val">{paths.appDir}</div>
              <div className="modal-kv-key">{t('settings.configKey')}</div>
              <div className="modal-kv-val">{paths.configFile}</div>
            </div>
          </section>

          <section className="modal-section">
            <h4>{t('settings.cacheDirTitle')}</h4>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {t('settings.cacheDirHint')}
            </p>
            <div className="modal-kv">
              <div className="modal-kv-key">{t('settings.currentDir')}</div>
              <div className="modal-kv-val">{paths.reposDir}</div>
              <div className="modal-kv-key">{t('settings.cacheUsage')}</div>
              <div className="modal-kv-val">
                {totalBytes === null ? t('settings.calculating') : formatBytes(totalBytes)}
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
                      title: t('settings.pickCacheDirTitle'),
                    });
                    if (r.path) {
                      setReposDirInput(r.path);
                      setSaved(false);
                    }
                  })();
                }}
                title={t('settings.pickDirectory')}
                aria-label={t('settings.pickDirectory')}
              >
                <FolderIcon />
              </button>
            </div>
            <p className="muted modal-footer">{t('settings.cacheDirRestartNote')}</p>
          </section>

          <section className="modal-section">
            <h4>{t('settings.runtimeTitle')}</h4>
            <div className="modal-kv">
              <div className="modal-kv-key">{t('settings.appVersion')}</div>
              <div className="modal-kv-val">{info.appVersion}</div>
              <div className="modal-kv-key">Electron</div>
              <div className="modal-kv-val">{info.electronVersion}</div>
              <div className="modal-kv-key">Node</div>
              <div className="modal-kv-val">{info.nodeVersion}</div>
              <div className="modal-kv-key">{t('settings.platform')}</div>
              <div className="modal-kv-val">{info.platform}</div>
            </div>
            <div className="settings-actions" style={{ marginTop: 10, alignItems: 'center' }}>
              <UpdateCheckButton enabled={config.update.check_enabled} />
              <button
                className="btn"
                type="button"
                style={{ marginLeft: 'auto' }}
                onClick={() => void invoke('app:openDevTools', undefined)}
                title={t('settings.openDevToolsTitle')}
              >
                {t('settings.openDevTools')}
              </button>
            </div>
            {/* 关于 & 反馈：低频社区链接。http(s) 外链由 App 顶层点击拦截走 openExternal 在系统浏览器打开。 */}
            <div className="settings-about-links">
              <span className="muted settings-about-label">{t('settings.aboutFeedback')}</span>
              <a
                className="settings-about-link"
                href="https://github.com/huhamhire/code-meeseeks"
                target="_blank"
                rel="noreferrer"
              >
                <GitHubMarkIcon size={14} />
                {t('settings.starOnGithub')}
              </a>
              <a
                className="settings-about-link"
                href="https://github.com/huhamhire/code-meeseeks/issues/new"
                target="_blank"
                rel="noreferrer"
              >
                <IssueIcon size={14} />
                {t('settings.reportIssue')}
              </a>
              <a
                className="settings-about-link"
                href="https://github.com/huhamhire/code-meeseeks/releases"
                target="_blank"
                rel="noreferrer"
              >
                <TagIcon size={14} />
                {t('settings.releases')}
              </a>
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
              {opening ? t('settings.opening') : t('settings.editConfigYaml')}
            </button>
          </div>
          <div className="modal-footer-right">
            {(saveError ?? openError) && (
              <span className="error-text">{saveError ?? openError}</span>
            )}
            {saved && !anyChanged && <span className="muted">{t('settings.saved')}</span>}
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void saveAll()}
              disabled={!anyChanged || saving}
            >
              {saving ? t('settings.saving') : t('common.save')}
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
          title={t('settings.deleteConnectionConfirmTitle')}
          message={t('settings.deleteConnectionConfirmMessage', {
            name: connections.find((c) => c.id === connDeleteId)?.display_name || connDeleteId,
          })}
          confirmLabel={t('common.delete')}
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

/** 「检查更新」按钮（运行环境段）：手动查 GitHub 最新版，自管 loading + 结果展示。
 *  enabled=false（config.update.check_enabled 关闭）时禁用按钮并提示，不发起检测。 */
function UpdateCheckButton({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  if (!enabled) {
    return (
      <>
        <button className="btn" type="button" disabled title={t('settings.updateDisabledTitle')}>
          {t('settings.checkUpdate')}
        </button>
        <span className="muted">{t('settings.updateDisabledHint')}</span>
      </>
    );
  }
  const run = async (): Promise<void> => {
    setChecking(true);
    try {
      setResult(await invoke('app:checkUpdate', undefined));
    } catch (e) {
      setResult({
        ok: false,
        hasUpdate: false,
        currentVersion: '',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <button
        className="btn"
        type="button"
        onClick={() => void run()}
        disabled={checking}
        title={t('settings.checkUpdateTitle')}
      >
        {checking ? t('settings.checking') : t('settings.checkUpdate')}
      </button>
      {result &&
        !checking &&
        (result.ok ? (
          result.hasUpdate ? (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => result.url && void invoke('app:openExternal', { url: result.url })}
            >
              {t('settings.updateAvailableLabel', { version: result.latestVersion })}
            </button>
          ) : (
            <span className="muted">{t('settings.upToDate')}</span>
          )
        ) : (
          <span className="error-text">{t('settings.checkFailed', { error: result.error })}</span>
        ))}
    </>
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
  const { t } = useTranslation();
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
          <h3>
            {mode === 'add' ? t('settings.addConnectionTitle') : t('settings.editConnectionTitle')}
          </h3>
        </div>
        <div className="modal-body">
          {/* 平台选择仅新增时可改；编辑既有连接不允许切平台（base_url/token 语义不同） */}
          {mode === 'add' && (
            <div className="modal-kv" style={{ marginBottom: 8 }}>
              <div className="modal-kv-key">{t('settings.platform')}</div>
              <div className="modal-kv-val">
                <select
                  className="settings-input"
                  value={draft.kind}
                  onChange={(e) =>
                    onChange({ ...draft, kind: e.target.value as ConnDraft['kind'] })
                  }
                >
                  <option value="github">{t('settings.platformGithub')}</option>
                  <option value="bitbucket-server">Bitbucket Server / Data Center</option>
                  <option value="gitlab">{t('settings.platformGitlab')}</option>
                </select>
              </div>
            </div>
          )}
          <ConnectionForm draft={draft} onChange={onChange} />
          <div
            className="settings-actions"
            style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <button type="button" className="btn" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={!canSave}
              title={!canSave ? t('settings.connSaveHint') : undefined}
            >
              {t('common.save')}
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
  const { t } = useTranslation();
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
          <h3>{t('settings.proxyTitle')}</h3>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ margin: '0 0 10px' }}>
            {t('settings.proxyModalHint')}
          </p>
          <label className="settings-secret-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              aria-label={t('settings.enableProxy')}
            />
            <span className="muted">{t('settings.enableProxy')}</span>
          </label>
          {draft.enabled && (
            <>
              {/* 字段名放输入框前（modal-kv 网格）；用户名 / 密码分上下两行，均可选 */}
              <div className="modal-kv" style={{ marginTop: 10, alignItems: 'center' }}>
                <div className="modal-kv-key">{t('settings.proxyHost')}</div>
                <div className="modal-kv-val">
                  <input
                    type="text"
                    className="settings-input"
                    value={draft.host}
                    onChange={(e) => patch({ host: e.target.value.trim() })}
                    placeholder={t('settings.proxyHostPlaceholder')}
                    aria-label={t('settings.proxyHostAria')}
                  />
                </div>
                <div className="modal-kv-key">{t('settings.proxyPort')}</div>
                <div className="modal-kv-val">
                  <input
                    type="number"
                    className="settings-input"
                    value={draft.port}
                    min={1}
                    max={65535}
                    onChange={(e) => patch({ port: Number.parseInt(e.target.value, 10) || 0 })}
                    aria-label={t('settings.proxyPortAria')}
                  />
                </div>
                <div className="modal-kv-key">{t('settings.proxyUsername')}</div>
                <div className="modal-kv-val">
                  <input
                    type="text"
                    className="settings-input"
                    value={draft.username}
                    onChange={(e) => patch({ username: e.target.value })}
                    placeholder={t('settings.proxyUsernamePlaceholder')}
                    aria-label={t('settings.proxyUsernameAria')}
                    autoComplete="off"
                  />
                </div>
                <div className="modal-kv-key">{t('settings.proxyPassword')}</div>
                <div className="modal-kv-val">
                  <div className="settings-secret-row">
                    <input
                      type={pwVisible ? 'text' : 'password'}
                      className="settings-input"
                      value={draft.password}
                      onChange={(e) => patch({ password: e.target.value })}
                      placeholder={t('settings.proxyPasswordPlaceholder')}
                      aria-label={t('settings.proxyPasswordAria')}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      onClick={() => setPwVisible((v) => !v)}
                      title={pwVisible ? t('settings.hide') : t('settings.show')}
                      aria-label={pwVisible ? t('settings.hide') : t('settings.show')}
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
                  {test.testing ? t('settings.testing') : t('settings.testProxy')}
                </button>
                {test.result &&
                  (test.result.ok ? (
                    <span className="muted" style={{ color: '#16825d' }}>
                      {t('settings.proxyOk')}
                    </span>
                  ) : (
                    <span className="error-text">
                      ✗ {test.result.reason ?? t('settings.testFailed')}
                    </span>
                  ))}
              </div>
            </>
          )}
          <div
            className="settings-actions"
            style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <button type="button" className="btn" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={draft.enabled && !draft.host}
              title={draft.enabled && !draft.host ? t('settings.proxyHostRequired') : undefined}
            >
              {t('common.confirm')}
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
  const { t } = useTranslation();
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
          <h3>{mode === 'add' ? t('settings.addLlmTitle') : t('settings.editLlmTitle')}</h3>
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
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={trySave}
              disabled={forceShowErrors && !isValid}
              title={forceShowErrors && !isValid ? t('settings.fillRequiredHint') : undefined}
            >
              {t('common.save')}
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
