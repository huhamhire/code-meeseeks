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
import { wireChatRunStore } from './stores/chat-run-store';
import { wireDraftsStore } from './stores/drafts-store';
import { wireRepoSyncStore } from './stores/repo-sync-store';
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
  /**
   * M4 跨组件跳转 (ADR-0007)：ChatPane finding card 点"编辑" → 这里 set →
   * MainPane 切 tab='diff' + 透传给 DiffView → DiffView 消费完调 onConsumed 清空。
   * 一次性 token；非 null 时 DiffView 应该 scroll + highlight (+ open edit zone
   * 如果带 runId/findingId 能反查到 finding-source 草稿)。
   *
   * runId/findingId 可选：
   * - ChatPane finding card 跳转 → 必带，DiffView 据此找草稿自动 enter edit
   * - PublishReviewModal anchor 点击 → 只带 anchor，DiffView 仅 navigate 不进 edit
   *   (用户在 modal 里看到某条想确认上下文，跳过去看一眼，不一定要改)
   */
  const [pendingDiffNav, setPendingDiffNav] = useState<{
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null>(null);
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

  // 启动时把 pr-agent 活动 run + 实时 stdout 流接到全局 store；ChatPane 跨 PR
  // 切换时可读 store 拿回运行中的状态 (本组件挂载到树根，效果等价于"应用级 hook")
  useEffect(() => wireChatRunStore(), []);
  // 同样思路：把 repo sync 事件流接到 store，StatusBar 任意时刻可读当前活动同步任务
  useEffect(() => wireRepoSyncStore(), []);
  // M4 草稿事件 → store；写盘后 drafts:changed 触发指定 PR 的草稿列表自动刷新
  useEffect(() => wireDraftsStore(), []);

  // 全局外链跳转防护 — 所有 UGC 场景 (评论 / PR 描述 / finding / chat 等) 内
  // 的 <a href="http(s)://"> 点击都走系统默认浏览器，不允许 Electron 在 app
  // window 内直接跳转覆盖整个界面。capture 阶段 listener 先于 React onClick 跑
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!(target instanceof HTMLAnchorElement)) return;
      const href = target.getAttribute('href');
      if (!href || !/^https?:\/\//.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      void invoke('app:openExternal', { url: href });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // 窗口重新获得焦点时主动 refresh 远端：调 prs:refresh 拉 PR meta，BBS 上
  // 加 comment / 改状态后 PR.updatedAt 跳变 → MainPane useEffect 的 prUpdatedAt
  // dep 触发 → force listComments 拉到新评论。比纯 reloadPrs (只读 cache) 多
  // 一次远端调用但能跟上"用户切到 BBS 评论再切回应用"的常见场景
  useEffect(() => {
    const onFocus = (): void => {
      if (!boot) return;
      void (async () => {
        try {
          await invoke('prs:refresh', undefined);
          await reloadPrs();
        } catch {
          // 静默：focus 触发的刷新失败不该弹错给用户
        }
      })();
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

  const mergeSelectedPr = useCallback(async (): Promise<void> => {
    if (!selected) return;
    const mergedId = selected.localId;
    try {
      await invoke('prs:merge', { localId: mergedId });
    } catch (e) {
      console.error('merge failed', e);
      return;
    }
    // 合并成功：PR 已转 MERGED，会从 pending 列表退场。取消选中 + 刷新让其消失
    if (selectedId === mergedId) setSelectedId(null);
    await triggerRefresh();
  }, [selected, selectedId, triggerRefresh]);

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
          onMerge={() => void mergeSelectedPr()}
          pendingDiffNav={pendingDiffNav}
          onDiffNavConsumed={() => setPendingDiffNav(null)}
          onRequestDiffNav={(target) => setPendingDiffNav(target)}
        />
        {/* ChatPane 始终挂载，折叠只是 CSS 隐藏：保住运行中的 run 生命周期。
            如果走条件渲染，折叠 = 卸载组件，进行中的计时器 / runProgress 订阅
            全丢，再展开只能从持久化里看到已完成的结果 */}
        <ChatPane
          pr={selected}
          prAgent={boot.prAgent}
          width={chatWidth}
          onResize={setChatWidth}
          collapsed={chatCollapsed}
          onJumpToDraftEditor={(t) => setPendingDiffNav(t)}
          onSetReviewStatus={(s) => void setSelectedPrStatus(s)}
        />
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
        onJumpToPr={setSelectedId}
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
