import { useCallback, useEffect, useState } from 'react';
import type {
  AppInfo,
  AppPaths,
  Config,
  ConnectionSummary,
  LocalPrStatus,
  PrAgentStatus,
  StoredPullRequest,
} from '@pr-pilot/shared';
import { invoke, subscribe } from './api';
import { ChatPane, CHAT_MAX_WIDTH, CHAT_MIN_WIDTH } from './components/ChatPane';
import { MainPane } from './components/MainPane';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';

interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  prAgent: PrAgentStatus;
  connections: ConnectionSummary[];
  lastSyncAt: string | null;
}

export default function App() {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = localStorage.getItem('pr-pilot.sidebarWidth');
    const n = raw ? Number(raw) : 360;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Number.isFinite(n) ? n : 360));
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('pr-pilot.sidebarCollapsed') === '1',
  );
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const raw = localStorage.getItem('pr-pilot.chatWidth');
    const n = raw ? Number(raw) : 360;
    return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, Number.isFinite(n) ? n : 360));
  });
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(
    // 默认收起：M3 之前 chat 还是空壳，避免空占地方
    () => (localStorage.getItem('pr-pilot.chatCollapsed') ?? '1') === '1',
  );
  useEffect(() => {
    localStorage.setItem('pr-pilot.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem('pr-pilot.sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('pr-pilot.chatWidth', String(chatWidth));
  }, [chatWidth]);
  useEffect(() => {
    localStorage.setItem('pr-pilot.chatCollapsed', chatCollapsed ? '1' : '0');
  }, [chatCollapsed]);

  const reloadPrs = useCallback(async (): Promise<void> => {
    const fresh = await invoke('prs:list', undefined);
    setPrs(fresh);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (!window.api) {
          throw new Error('preload bridge missing: window.api is undefined');
        }
        const [info, paths, config, prAgent, initialPrs, connections, lastSync] =
          await Promise.all([
            invoke('app:info', undefined),
            invoke('app:paths', undefined),
            invoke('config:read', undefined),
            invoke('app:prAgentStatus', undefined),
            invoke('prs:list', undefined),
            invoke('app:connections', undefined),
            invoke('prs:lastSync', undefined),
          ]);
        setBoot({ info, paths, config, prAgent, connections, lastSyncAt: lastSync.at });
        setPrs(initialPrs);
        setLastSyncAt(lastSync.at);
      } catch (e) {
        setFatalError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 窗口重新获得焦点时自动拉一次新鲜列表（不重新触发 poll，避免远端压力）
  useEffect(() => {
    const onFocus = (): void => {
      if (boot) void reloadPrs();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [boot, reloadPrs]);

  // 订阅 main 推送的 poll tick；用于刷新 statusbar "最近同步" 显示，
  // 并顺便重拉一次 PR 列表使后台轮询新增/删除立刻反映在 UI。
  useEffect(() => {
    if (!window.api) return;
    return subscribe('poll:tick', (info) => {
      setLastSyncAt(info.at);
      void reloadPrs();
    });
  }, [reloadPrs]);

  const triggerRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await invoke('prs:refresh', undefined);
      await reloadPrs();
    } catch (e) {
      console.error('refresh failed', e);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, reloadPrs]);

  const selected = prs.find((p) => p.localId === selectedId) ?? null;

  const setSelectedPrStatus = useCallback(
    async (status: LocalPrStatus): Promise<void> => {
      if (!selected) return;
      const updated = await invoke('prs:setLocalStatus', {
        localId: selected.localId,
        status,
      });
      if (updated) {
        setPrs((prev) => prev.map((p) => (p.localId === updated.localId ? updated : p)));
      }
    },
    [selected],
  );

  if (fatalError) {
    return (
      <div className="app fatal-app">
        <pre className="fatal-msg">{fatalError}</pre>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="app fatal-app">
        <p className="muted">加载中…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-body">
        {!sidebarCollapsed && (
          <Sidebar
            prs={prs}
            selectedId={selectedId}
            onSelect={(pr) => setSelectedId(pr.localId)}
            width={sidebarWidth}
            onResize={setSidebarWidth}
          />
        )}
        <MainPane
          pr={selected}
          hasConnections={boot.config.connections.length > 0}
          onSetStatus={(s) => void setSelectedPrStatus(s)}
        />
        {!chatCollapsed && (
          <ChatPane
            pr={selected}
            prAgent={boot.prAgent}
            width={chatWidth}
            onResize={setChatWidth}
          />
        )}
      </div>
      <StatusBar
        prsCount={prs.length}
        prAgent={boot.prAgent}
        connections={boot.connections}
        llm={boot.config.llm}
        refreshing={refreshing}
        sidebarCollapsed={sidebarCollapsed}
        chatCollapsed={chatCollapsed}
        lastSyncAt={lastSyncAt}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
        onToggleChat={() => setChatCollapsed((c) => !c)}
        onRefresh={() => void triggerRefresh()}
        onOpenSettings={() => setShowSettings(true)}
        onSwitchActiveLlm={(id) => {
          const next = { ...boot.config.llm, active_id: id };
          void invoke('config:setLlm', { llm: next });
          setBoot((b) => (b ? { ...b, config: { ...b.config, llm: next } } : b));
        }}
      />
      {showSettings && (
        <SettingsModal
          info={boot.info}
          paths={boot.paths}
          config={boot.config}
          onLlmChange={(llm) =>
            setBoot((b) => (b ? { ...b, config: { ...b.config, llm } } : b))
          }
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
