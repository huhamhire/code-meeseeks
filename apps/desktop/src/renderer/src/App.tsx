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
import { invoke } from './api';
import { MainPane } from './components/MainPane';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';

interface BootstrapState {
  info: AppInfo;
  paths: AppPaths;
  config: Config;
  prAgent: PrAgentStatus;
  connections: ConnectionSummary[];
}

export default function App() {
  const [boot, setBoot] = useState<BootstrapState | null>(null);
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

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
        const [info, paths, config, prAgent, initialPrs, connections] = await Promise.all([
          invoke('app:info', undefined),
          invoke('app:paths', undefined),
          invoke('config:read', undefined),
          invoke('app:prAgentStatus', undefined),
          invoke('prs:list', undefined),
          invoke('app:connections', undefined),
        ]);
        setBoot({ info, paths, config, prAgent, connections });
        setPrs(initialPrs);
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
        <Sidebar prs={prs} selectedId={selectedId} onSelect={(pr) => setSelectedId(pr.localId)} />
        <MainPane
          pr={selected}
          hasConnections={boot.config.connections.length > 0}
          onSetStatus={(s) => void setSelectedPrStatus(s)}
        />
      </div>
      <StatusBar
        prsCount={prs.length}
        prAgent={boot.prAgent}
        connections={boot.connections}
        refreshing={refreshing}
        onRefresh={() => void triggerRefresh()}
        onOpenSettings={() => setShowSettings(true)}
      />
      {showSettings && (
        <SettingsModal
          info={boot.info}
          paths={boot.paths}
          config={boot.config}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
