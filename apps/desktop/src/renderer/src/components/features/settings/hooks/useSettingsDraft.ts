import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppPaths, Config, LlmProfile, SupportedLanguage } from '@meebox/shared';
import { invoke } from '../../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../../i18n';
import { fromConnDraft, toConnDraft, type ConnDraft } from '../ConnectionForm';
import { newProfileId } from '../LlmProfileForm';

interface UseSettingsDraftParams {
  config: Config;
  paths: AppPaths;
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  onLanguageChange?: (language: SupportedLanguage) => void;
  onConnectionsChange?: () => void | Promise<void>;
  onClose: () => void;
}

/**
 * SettingsModal 的「草稿 → 整体保存」状态机：所有编辑只改本地 state，点底栏「保存」才整体写盘 +
 * 生效；连接 / LLM 改动额外自动写入 config.yaml（防丢失）但不应用到运行时。语言为即时生效项（不走全局
 * 保存）。对外暴露各分区所需的语义化 state 与 setter（编辑即标脏），以及编辑器弹窗状态与 saveAll。
 */
export function useSettingsDraft({
  config,
  paths,
  onLlmChange,
  onProxyChange,
  onLanguageChange,
  onConnectionsChange,
  onClose,
}: UseSettingsDraftParams) {
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

  // 连接：多条可配置 + 单选启用；编辑只改本地 state，整体保存才写盘 + 热重建
  const [connections, setConnections] = useState<Config['connections']>(config.connections);
  const [activeConnId, setActiveConnId] = useState<string>(config.active_connection_id);
  const [connEditor, setConnEditor] = useState<{ mode: 'add' | 'edit'; draft: ConnDraft } | null>(
    null,
  );
  const [connDeleteId, setConnDeleteId] = useState<string | null>(null);

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

  // UI 语言：即时生效项（不走全局保存）
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

  // 连接 / LLM 编辑：改本地 state + 自动写入 config.yaml（防丢失），但不应用到运行时
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

  // ── LLM 配置 ──
  const persistLlm = (next: Config['llm']): void => {
    setLlm(next);
    setSaved(false);
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
  const closeLlmEditor = (): void => setLlmEditor(null);
  const saveLlmEditor = async (): Promise<void> => {
    if (!llmEditor) return;
    const { mode, draft } = llmEditor;
    const profiles =
      mode === 'add'
        ? [...llm.profiles, draft]
        : llm.profiles.map((p) => (p.id === draft.id ? draft : p));
    const active_id = mode === 'add' && !llm.active_id ? draft.id : llm.active_id;
    persistLlm({ profiles, active_id });
    setLlmEditor(null);
  };
  const deleteProfile = (id: string): void => {
    const profiles = llm.profiles.filter((p) => p.id !== id);
    const active_id = llm.active_id === id ? (profiles[0]?.id ?? '') : llm.active_id;
    persistLlm({ profiles, active_id });
  };
  const setActiveLlm = (id: string): void => {
    if (llm.active_id === id) return;
    persistLlm({ ...llm, active_id: id });
  };

  // ── 连接 ──
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
  const saveConnEditor = (): void => {
    if (!connEditor) return;
    const { mode, draft } = connEditor;
    const conn = fromConnDraft(draft);
    const next =
      mode === 'add' ? [...connections, conn] : connections.map((c) => (c.id === conn.id ? conn : c));
    // 新增首条自动设为启用
    const activeId = mode === 'add' && !activeConnId ? conn.id : activeConnId;
    persistConnections(next, activeId);
    setConnEditor(null);
  };
  const deleteConn = (id: string): void => {
    const next = connections.filter((c) => c.id !== id);
    // 删的是当前启用 → 启用回退到剩下第一条（无则空串，不轮询任何连接）
    const activeId = activeConnId === id ? (next[0]?.id ?? '') : activeConnId;
    persistConnections(next, activeId);
  };
  const setActiveConn = (id: string): void => {
    if (activeConnId === id) return;
    persistConnections(connections, id);
  };

  // ── 代理 ──
  const saveProxyEditor = (): void => {
    if (!proxyEditor) return;
    setProxy(proxyEditor);
    setProxyEditor(null);
    setSaved(false);
  };

  // ── 目录 / 轮询的语义化 setter（编辑即标脏）──
  const setPoller = (seconds: number): void => {
    setPollerInput(String(seconds));
    setSaved(false);
  };
  const setAgentDir = (v: string): void => {
    setAgentDirInput(v);
    setSaved(false);
  };
  const setReposDir = (v: string): void => {
    setReposDirInput(v);
    setSaved(false);
  };
  const pickAgentDir = async (): Promise<void> => {
    const r = await invoke('dialog:pickDirectory', {
      defaultPath: agentDirInput.trim() || paths.appDir,
      title: t('settings.pickAgentDirTitle'),
    });
    if (r.path) setAgentDir(r.path);
  };
  const pickReposDir = async (): Promise<void> => {
    const r = await invoke('dialog:pickDirectory', {
      defaultPath: reposDirInput.trim() || paths.reposDir,
      title: t('settings.pickCacheDirTitle'),
    });
    if (r.path) setReposDir(r.path);
  };

  // ── 变更检测（对比基线）+ 整体保存 ──
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
        if (!Number.isFinite(n) || n < 60 || n > 900) throw new Error(t('settings.pollerRangeError'));
        await invoke('config:setPoller', { interval_seconds: n });
      }
      if (agentChanged) {
        // 仅 UI 编辑 dir；其余字段从已加载的 config 原样保留，避免被覆盖成默认值。
        await invoke('config:setAgent', { agent: { ...agent, dir: agentDirInput.trim() } });
      }
      if (llmChanged) {
        await invoke('config:setLlm', { llm });
        onLlmChange?.(llm);
      }
      if (proxyChanged) {
        await invoke('config:setProxy', { proxy });
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

  return {
    // 语言
    language,
    handleLanguageChange,
    // 连接
    connections,
    activeConnId,
    connEditor,
    setConnEditor,
    connDeleteId,
    setConnDeleteId,
    openAddConn,
    openEditConn,
    saveConnEditor,
    deleteConn,
    setActiveConn,
    // LLM
    llm,
    llmEditor,
    setLlmEditor,
    openAddProfile,
    openEditProfile,
    closeLlmEditor,
    saveLlmEditor,
    deleteProfile,
    setActiveLlm,
    // 代理
    proxy,
    proxyEditor,
    setProxyEditor,
    saveProxyEditor,
    // 轮询 / 目录
    pollerInput,
    setPoller,
    agentDirInput,
    setAgentDir,
    pickAgentDir,
    reposDirInput,
    setReposDir,
    pickReposDir,
    totalBytes,
    // 保存 / 配置文件
    opening,
    openError,
    openConfigFile,
    saving,
    saved,
    saveError,
    anyChanged,
    saveAll,
  };
}
