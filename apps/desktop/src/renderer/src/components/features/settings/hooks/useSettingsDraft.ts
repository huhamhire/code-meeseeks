import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppPaths, Config, LlmProfile } from '@meebox/shared';
import { invoke } from '../../../../api';
import { fromConnDraft, toConnDraft, type ConnDraft } from '../ConnectionForm';
import { newProfileId } from '../LlmProfileForm';

interface UseSettingsDraftParams {
  config: Config;
  paths: AppPaths;
  onLlmChange?: (llm: Config['llm']) => void;
  onProxyChange?: (proxy: Config['proxy']) => void;
  onConnectionsChange?: () => void | Promise<void>;
  /** After a successful save-all, passes back the authoritative written config so the parent can sync boot.config (reopening the settings page shows the latest values). */
  onConfigPersisted?: (config: Config) => void;
  onClose: () => void;
}

/**
 * SettingsModal's "draft → save-all" state machine: all edits only change local state; clicking the footer "Save" writes to disk +
 * takes effect as a whole; connection / LLM changes are additionally auto-written to config.yaml (to prevent loss) but not applied to the runtime. Exposes the
 * semantic state and setters each section needs (editing marks dirty), plus editor popup state and saveAll. Instant-effect appearance settings
 * (language / theme / editor appearance) are orthogonal to this transaction and split out into useAppearanceDraft.
 */
export function useSettingsDraft({
  config,
  paths,
  onLlmChange,
  onProxyChange,
  onConnectionsChange,
  onConfigPersisted,
  onClose,
}: UseSettingsDraftParams) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // draft → save-all: all edits only change local state; clicking the footer "Save" writes to disk + takes effect as a whole
  const [reposDirInput, setReposDirInput] = useState(config.workspace.repos_dir);
  // Agent's other fields (max_steps / summary_max_chars / autopilot) are not edited in the UI, only held so that on save they are
  // passed back as-is and not overwritten with defaults; dir is editable via agentDirInput, strategy toggles via autoFollowup.
  const [agent] = useState<Config['agent']>(config.agent);
  const [agentDirInput, setAgentDirInput] = useState(config.agent.dir);
  // Agent strategy (auto-followup toggle + followup count cap + code-suggestion count cap). Saved together with config:setAgent.
  const [autoFollowup, setAutoFollowupState] = useState(config.agent.strategy.auto_followup);
  const [maxFollowupAsks, setMaxFollowupAsksState] = useState(
    config.agent.strategy.max_followup_asks,
  );
  const [maxCodeSuggestions, setMaxCodeSuggestionsState] = useState(
    config.agent.strategy.max_code_suggestions,
  );
  const [pollerInput, setPollerInput] = useState(String(config.poller.interval_seconds));
  const [maxConcurrencyInput, setMaxConcurrencyInput] = useState(config.pr_agent.max_concurrency);
  const [llm, setLlm] = useState<Config['llm']>(config.llm);
  const [llmEditor, setLlmEditor] = useState<{ mode: 'add' | 'edit'; draft: LlmProfile } | null>(
    null,
  );
  // Message notifications (master toggle + per-type system notifications + dock badge). Saved with config:setNotifications.
  const [notifications, setNotificationsState] = useState<Config['notifications']>(
    config.notifications,
  );
  const [proxy, setProxy] = useState<Config['proxy']>(config.proxy);
  // Proxy is edited in a separate modal: null=closed, non-null=draft being edited; saved back to proxy, written to disk only on footer "Save".
  const [proxyEditor, setProxyEditor] = useState<Config['proxy'] | null>(null);

  // Local API service listener (toggle / host / port follow save-all; token written to disk immediately via generateServiceToken).
  const [service, setServiceState] = useState<Config['service']>(config.service);

  // Connections: multiple configurable + single-select enabled; editing only changes local state, save-all writes to disk + hot-rebuilds
  const [connections, setConnections] = useState<Config['connections']>(config.connections);
  const [activeConnId, setActiveConnId] = useState<string>(config.active_connection_id);
  const [connEditor, setConnEditor] = useState<{ mode: 'add' | 'edit'; draft: ConnDraft } | null>(
    null,
  );
  const [connDeleteId, setConnDeleteId] = useState<string | null>(null);

  // Save baseline: updated after a successful save, used for changed detection (to disable the save button)
  const [base, setBase] = useState(() => ({
    reposDir: config.workspace.repos_dir,
    agentDir: config.agent.dir,
    autoFollowup: config.agent.strategy.auto_followup,
    maxFollowupAsks: config.agent.strategy.max_followup_asks,
    maxCodeSuggestions: config.agent.strategy.max_code_suggestions,
    poller: config.poller.interval_seconds,
    concurrency: config.pr_agent.max_concurrency,
    llm: config.llm,
    proxy: config.proxy,
    notifications: config.notifications,
    service: config.service,
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

  // Connection / LLM editing: change local state + auto-write to config.yaml (to prevent loss), but not applied to the runtime
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
      /* Autosave failure does not interrupt editing; it will be written again on footer save */
    });
  };

  // ── LLM config ──
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
    persistLlm({ ...llm, profiles, active_id });
    setLlmEditor(null);
  };
  const deleteProfile = (id: string): void => {
    const profiles = llm.profiles.filter((p) => p.id !== id);
    const active_id = llm.active_id === id ? (profiles[0]?.id ?? '') : llm.active_id;
    persistLlm({ ...llm, profiles, active_id });
  };
  const setActiveLlm = (id: string): void => {
    if (llm.active_id === id) return;
    persistLlm({ ...llm, active_id: id });
  };
  // Context length belongs to llm (saved together with config:setLlm); editing goes through persistLlm (mark dirty + draft write-to-disk).
  const setLlmContextTokens = (tokens: number): void => {
    if (llm.context_tokens === tokens) return;
    persistLlm({ ...llm, context_tokens: tokens });
  };

  // ── Connections ──
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
    // The first added one is automatically set as enabled
    const activeId = mode === 'add' && !activeConnId ? conn.id : activeConnId;
    persistConnections(next, activeId);
    setConnEditor(null);
  };
  const deleteConn = (id: string): void => {
    const next = connections.filter((c) => c.id !== id);
    // Deleting the currently enabled one → enabled falls back to the first remaining (empty string if none, polls no connection)
    const activeId = activeConnId === id ? (next[0]?.id ?? '') : activeConnId;
    persistConnections(next, activeId);
  };
  const setActiveConn = (id: string): void => {
    if (activeConnId === id) return;
    persistConnections(connections, id);
  };

  // ── Proxy ──
  const saveProxyEditor = (): void => {
    if (!proxyEditor) return;
    setProxy(proxyEditor);
    setProxyEditor(null);
    setSaved(false);
  };

  // ── Semantic setters for directory / polling (editing marks dirty) ──
  const setPoller = (seconds: number): void => {
    setPollerInput(String(seconds));
    setSaved(false);
  };
  const setMaxConcurrency = (max: number): void => {
    setMaxConcurrencyInput(max);
    setSaved(false);
  };
  const setNotifications = (next: Config['notifications']): void => {
    setNotificationsState(next);
    setSaved(false);
  };
  const setService = (next: Config['service']): void => {
    setServiceState(next);
    setSaved(false);
  };
  // Token regeneration only updates the draft and marks dirty (not written to disk, does not sync baseline): like host / port, follows the draft model, takes effect
  // via config:setService on footer "Save"; if not saved it is discarded, keeping the original token. functional update avoids a race with toggle switching.
  const regenerateServiceToken = async (): Promise<void> => {
    try {
      const { token } = await invoke('config:generateServiceToken', undefined);
      setServiceState((prev) => ({ ...prev, token }));
      setSaved(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };
  const setAgentDir = (v: string): void => {
    setAgentDirInput(v);
    setSaved(false);
  };
  const setAutoFollowup = (v: boolean): void => {
    setAutoFollowupState(v);
    setSaved(false);
  };
  const setMaxFollowupAsks = (n: number): void => {
    setMaxFollowupAsksState(n);
    setSaved(false);
  };
  const setMaxCodeSuggestions = (n: number): void => {
    setMaxCodeSuggestionsState(n);
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

  // ── Change detection (compare against baseline) + save-all ──
  const reposDirChanged = reposDirInput.trim() !== base.reposDir;
  const agentChanged =
    agentDirInput.trim() !== base.agentDir ||
    autoFollowup !== base.autoFollowup ||
    maxFollowupAsks !== base.maxFollowupAsks ||
    maxCodeSuggestions !== base.maxCodeSuggestions;
  const pollerChanged = pollerInput.trim() !== String(base.poller);
  const concurrencyChanged = maxConcurrencyInput !== base.concurrency;
  const llmChanged = JSON.stringify(llm) !== JSON.stringify(base.llm);
  const proxyChanged = JSON.stringify(proxy) !== JSON.stringify(base.proxy);
  const notificationsChanged =
    JSON.stringify(notifications) !== JSON.stringify(base.notifications);
  const serviceChanged = JSON.stringify(service) !== JSON.stringify(base.service);
  const connectionsChanged =
    activeConnId !== base.activeConnId ||
    JSON.stringify(connections) !== JSON.stringify(base.connections);
  const anyChanged =
    reposDirChanged ||
    agentChanged ||
    pollerChanged ||
    concurrencyChanged ||
    llmChanged ||
    proxyChanged ||
    notificationsChanged ||
    serviceChanged ||
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
      if (concurrencyChanged) {
        await invoke('config:setMaxConcurrency', { max_concurrency: maxConcurrencyInput });
      }
      if (agentChanged) {
        // UI edits dir + strategy toggles; other fields are kept as-is from the loaded config to avoid being overwritten with defaults.
        await invoke('config:setAgent', {
          agent: {
            ...agent,
            dir: agentDirInput.trim(),
            strategy: {
              ...agent.strategy,
              auto_followup: autoFollowup,
              max_followup_asks: maxFollowupAsks,
              max_code_suggestions: maxCodeSuggestions,
            },
          },
        });
      }
      if (llmChanged) {
        await invoke('config:setLlm', { llm });
        onLlmChange?.(llm);
      }
      if (proxyChanged) {
        await invoke('config:setProxy', { proxy });
        onProxyChange?.(proxy);
      }
      if (notificationsChanged) {
        await invoke('config:setNotifications', { notifications });
      }
      if (serviceChanged) {
        const host = service.host.trim();
        // Simple validation: non-empty, no whitespace / protocol / slash (port is separate); allows IPv4 / hostname / 0.0.0.0 / ::1.
        if (!host || !/^[A-Za-z0-9.:-]+$/.test(host)) {
          throw new Error(t('settings.serviceHostInvalidError'));
        }
        if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
          throw new Error(t('settings.servicePortRangeError'));
        }
        await invoke('config:setService', { service: { ...service, host } });
      }
      if (connectionsChanged) {
        await invoke('config:setConnections', { connections, active_connection_id: activeConnId });
        await onConnectionsChange?.();
      }
      if (reposDirChanged && reposDirInput.trim()) {
        await invoke('config:setReposDir', { reposDir: reposDirInput.trim() });
      }
      // Read back the authoritative written config to sync the parent's boot.config: otherwise items without an immediate callback like agent / poller / concurrency
      // would still read the stale boot.config when reopening the settings page (behavior has taken effect but the UI shows stale values). Includes main-side clamped values.
      onConfigPersisted?.(await invoke('config:read', undefined));
      setBase({
        reposDir: reposDirInput.trim(),
        agentDir: agentDirInput.trim(),
        autoFollowup,
        maxFollowupAsks,
        maxCodeSuggestions,
        poller: Number.parseInt(pollerInput, 10),
        concurrency: maxConcurrencyInput,
        llm,
        proxy,
        notifications,
        service,
        connections,
        activeConnId,
      });
      setSaved(true);
      // Automatically close the settings panel after a successful save (on failure, keep it open and show saveError)
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return {
    // connections
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
    setLlmContextTokens,
    // proxy
    proxy,
    proxyEditor,
    setProxyEditor,
    saveProxyEditor,
    // notifications
    notifications,
    setNotifications,
    // local API service listener
    service,
    setService,
    regenerateServiceToken,
    // polling / concurrency / directories
    pollerInput,
    setPoller,
    maxConcurrencyInput,
    setMaxConcurrency,
    agentDirInput,
    setAgentDir,
    pickAgentDir,
    autoFollowup,
    setAutoFollowup,
    maxFollowupAsks,
    setMaxFollowupAsks,
    maxCodeSuggestions,
    setMaxCodeSuggestions,
    reposDirInput,
    setReposDir,
    pickReposDir,
    totalBytes,
    // save / config file
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
