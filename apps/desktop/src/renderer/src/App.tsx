import { useCallback, useEffect, useState } from 'react';
import type {
  AppInfo,
  AppPaths,
  Config,
  ConnectionSummary,
  LocalPrStatus,
  PrAgentStatus,
  PrDiscoveryFilter,
  StoredPullRequest,
  UpdateCheckResult,
} from '@meebox/shared';
import { invoke, subscribe } from './api';
import { ChatPane, CHAT_MAX_WIDTH, CHAT_MIN_WIDTH } from './components/ChatPane';
import { wireChatRunStore } from './stores/chat-run-store';
import { wireDraftsStore } from './stores/drafts-store';
import { wireRepoSyncStore } from './stores/repo-sync-store';
import { MainPane } from './components/MainPane';
import { OnboardingWizard, type OnboardingResult } from './components/onboarding/OnboardingWizard';
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
  // 合并进行中：GitHub 合并可能较慢（异步算 mergeable），按钮置等待态并防重复点击。
  const [merging, setMerging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // 启动检测到的新版本（main 推 app:updateAvailable）；StatusBar 据此提示跳转下载。
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  // 操作级 toast（审批 / 合并等远端动作失败时提示，区别于 fatalError 整屏报错）。
  // key 用随机数：同样文案连续触发也能重置自动消失计时器。
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const notifyError = useCallback((text: string): void => {
    setToast({ text, key: Math.random() });
  }, []);
  // toast 自动消失（6s）；key 变化即重置计时
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
    // 仅依赖 key：同一 toast 重渲不重置计时，新 toast (key 变) 才重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.key]);
  // 仅调试用：localStorage 里 meebox.forceOnboarding='1' 时强制进首启向导，
  // 不必动 config.yaml。DevTools 设值后刷新进入；走完向导会自动清掉该 flag。
  // 详见 docs/development.md。
  const [forceOnboarding, setForceOnboarding] = useState(
    () => localStorage.getItem('meebox.forceOnboarding') === '1',
  );
  /**
   * M4 跨组件跳转：ChatPane finding card 点"编辑" → 这里 set →
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
  // GitHub 发现分类（运行时筛选，不持久化）；仅 GitHub 活动连接时在 PR 列表展示。
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = localStorage.getItem('meebox.sidebarWidth');
    const n = raw ? Number(raw) : 360;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Number.isFinite(n) ? n : 360));
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('meebox.sidebarCollapsed') === '1',
  );
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const raw = localStorage.getItem('meebox.chatWidth');
    const n = raw ? Number(raw) : 360;
    return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, Number.isFinite(n) ? n : 360));
  });
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(
    // 默认收起：M3 之前 chat 还是空壳，避免空占地方
    () => (localStorage.getItem('meebox.chatCollapsed') ?? '1') === '1',
  );
  useEffect(() => {
    localStorage.setItem('meebox.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem('meebox.sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('meebox.chatWidth', String(chatWidth));
  }, [chatWidth]);
  useEffect(() => {
    localStorage.setItem('meebox.chatCollapsed', chatCollapsed ? '1' : '0');
  }, [chatCollapsed]);

  const reloadPrs = useCallback(async (): Promise<void> => {
    const fresh = await invoke('prs:list', undefined);
    setPrs(fresh);
  }, []);

  // 连接改动（尤其切换活动连接）后整体刷新 boot：活动连接变化后 main 端 app:connections /
  // prs:list 都随之变，必须重拉，否则 boot.connections、PR 列表会过期。
  const refreshBootAndPrs = useCallback(async (): Promise<void> => {
    const [config, connections, freshPrs, lastSync] = await Promise.all([
      invoke('config:read', undefined),
      invoke('app:connections', undefined),
      invoke('prs:list', undefined),
      invoke('prs:lastSync', undefined),
    ]);
    setBoot((b) => (b ? { ...b, config, connections, lastSyncAt: lastSync.at } : b));
    setPrs(freshPrs);
    setLastSyncAt(lastSync.at);
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
  // 启动版本更新检测：main 仅在有新版时推 app:updateAvailable
  useEffect(() => subscribe('app:updateAvailable', (info) => setUpdateInfo(info)), []);
  // dev 调试钩子：控制台 dispatch CustomEvent 模拟「发现新版」以验证状态栏 chip
  // （dev 版本通常高于 latest，自然不会触发）。detail=null 清除。
  //   window.dispatchEvent(new CustomEvent('meebox:debug-update'))
  //   window.dispatchEvent(new CustomEvent('meebox:debug-update', { detail: { latestVersion: '1.2.3' } }))
  //   window.dispatchEvent(new CustomEvent('meebox:debug-update', { detail: null }))
  useEffect(() => {
    const onDebug = (e: Event): void => {
      const d = (e as CustomEvent<Partial<UpdateCheckResult> | null>).detail;
      setUpdateInfo(
        d === null
          ? null
          : {
              ok: true,
              hasUpdate: true,
              currentVersion: '0.0.0',
              latestVersion: '9.9.9',
              url: 'https://github.com/huhamhire/code-meeseeks/releases/latest',
              ...d,
            },
      );
    };
    window.addEventListener('meebox:debug-update', onDebug);
    return () => window.removeEventListener('meebox:debug-update', onDebug);
  }, []);

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

  // 窗口重新获得焦点时主动 refresh 远端：调 prs:refresh 拉 PR meta，Bitbucket 上
  // 加 comment / 改状态后 PR.updatedAt 跳变 → MainPane useEffect 的 prUpdatedAt
  // dep 触发 → force listComments 拉到新评论。比纯 reloadPrs (只读 cache) 多
  // 一次远端调用但能跟上"用户切到 Bitbucket 评论再切回应用"的常见场景
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
  // 同时刷新连接摘要：启动时连接的 ping（缓存 currentUser）在建窗后才完成，首轮 tick 即随其后，
  // 借此把状态栏用户/能力位补上（否则需手动刷新才显示）。app:connections 为廉价同步调用。
  useEffect(() => {
    if (!window.api) return;
    return subscribe('poll:tick', (info) => {
      setLastSyncAt(info.at);
      void reloadPrs();
      void invoke('app:connections', undefined).then(
        (connections) => {
          setBoot((b) => (b ? { ...b, connections } : b));
        },
        () => {
          /* 摘要刷新失败不影响主流程 */
        },
      );
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
  // 选中 PR 所属连接的能力位 + 当前 PAT 用户（多平台降级：审批按钮显隐 / 自己 PR 灰显）
  const selectedConn = selected
    ? boot?.connections.find((c) => c.connectionId === selected.connectionId)
    : undefined;

  const setSelectedPrStatus = useCallback(
    async (status: LocalPrStatus): Promise<void> => {
      if (!selected) return;
      try {
        const updated = await invoke('prs:setLocalStatus', {
          localId: selected.localId,
          status,
        });
        if (updated) {
          setPrs((prev) => prev.map((p) => (p.localId === updated.localId ? updated : p)));
        }
      } catch (e) {
        // 远端拒绝（如 PR 已关闭 / 合并 / 权限不足）→ 本地状态不变，弹 toast 提示。
        // 顺手刷新一次：PR 若已关闭，下一轮 poll 会把它软删，列表自洽
        const msg = e instanceof Error ? e.message : String(e);
        notifyError(`审批操作失败：${msg}`);
        void triggerRefresh();
      }
    },
    [selected, notifyError, triggerRefresh],
  );

  const mergeSelectedPr = useCallback(async (): Promise<void> => {
    if (!selected || merging) return;
    const mergedId = selected.localId;
    setMerging(true);
    try {
      await invoke('prs:merge', { localId: mergedId });
    } catch (e) {
      // 合并失败（冲突 / veto / 权限 / PR 已关闭）→ 弹 toast，本地不变
      const msg = e instanceof Error ? e.message : String(e);
      notifyError(`合并失败：${msg}`);
      void triggerRefresh();
      return;
    } finally {
      setMerging(false);
    }
    // 合并成功：PR 已转 MERGED，会从 pending 列表退场。取消选中 + 刷新让其消失
    if (selectedId === mergedId) setSelectedId(null);
    await triggerRefresh();
  }, [selected, selectedId, triggerRefresh, notifyError, merging]);

  // 首启向导完成：落盘连接（必）+ LLM / 缓存目录（按需），再重拉配置/连接/PR 更新
  // boot。boot.config 拿到有效 active 连接后，下方 needsOnboarding 派生为 false，
  // 向导自然卸载、切入主界面；主界面挂载后 poll:tick 订阅 + focus 刷新自然生效。
  const completeOnboarding = useCallback(
    async (result: OnboardingResult): Promise<void> => {
      await invoke('config:setConnections', {
        connections: [result.connection],
        active_connection_id: result.connection.id,
      });
      if (result.llm) {
        await invoke('config:setLlm', {
          llm: { profiles: [result.llm], active_id: result.llm.id },
        });
      }
      const trimmedRepos = result.reposDir.trim();
      if (trimmedRepos && trimmedRepos !== (boot?.config.workspace.repos_dir ?? '')) {
        await invoke('config:setReposDir', { reposDir: trimmedRepos });
      }
      const [config, connections, freshPrs, lastSync] = await Promise.all([
        invoke('config:read', undefined),
        invoke('app:connections', undefined),
        invoke('prs:list', undefined),
        invoke('prs:lastSync', undefined),
      ]);
      setBoot((b) => (b ? { ...b, config, connections, lastSyncAt: lastSync.at } : b));
      setPrs(freshPrs);
      setLastSyncAt(lastSync.at);
      // 走完向导清掉调试 flag，避免强制模式下完成后仍被困在向导
      if (forceOnboarding) {
        localStorage.removeItem('meebox.forceOnboarding');
        setForceOnboarding(false);
      }
    },
    [boot, forceOnboarding],
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

  // gate 条件 = 有无「有效的 active 连接」：连接为空 / active 悬空都触发首启向导。
  // 不依赖一次性 firstRun 标记 —— 用户清空连接后下次进入仍会回到向导。
  const needsOnboarding =
    forceOnboarding ||
    !boot.config.connections.some((c) => c.id === boot.config.active_connection_id);
  if (needsOnboarding) {
    return (
      <OnboardingWizard
        existingLlmProfiles={boot.config.llm.profiles}
        initialReposDir={boot.config.workspace.repos_dir}
        onComplete={completeOnboarding}
      />
    );
  }

  // 有 active 连接但 LLM 未配置 → ChatPane 给出「需配置才能启用」提示并禁用输入
  const llmConfigured = boot.config.llm.profiles.some((p) => p.id === boot.config.llm.active_id);

  // 发现分类标签由活动连接的能力决定（GitHub 四类、Bitbucket 两类、其余无）。
  const activeConnSummary = boot.connections.find(
    (c) => c.connectionId === boot.config.active_connection_id,
  );
  const availableDiscoveryFilters = activeConnSummary?.capabilities.discoveryFilters ?? [];
  const showDiscoveryFilter = availableDiscoveryFilters.length > 0;
  // 选中的分类可能因切换连接而对当前平台无效（如 github 的 mentioned 切到 bitbucket）→ 回落首个可用。
  const effectiveDiscoveryFilter = availableDiscoveryFilters.includes(discoveryFilter)
    ? discoveryFilter
    : availableDiscoveryFilters[0];

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
            availableFilters={showDiscoveryFilter ? availableDiscoveryFilters : undefined}
            discoveryFilter={showDiscoveryFilter ? effectiveDiscoveryFilter : undefined}
            onDiscoveryFilterChange={showDiscoveryFilter ? setDiscoveryFilter : undefined}
          />
        )}
        <MainPane
          pr={selected}
          hasConnections={boot.config.connections.length > 0}
          onSetStatus={(s) => void setSelectedPrStatus(s)}
          onMerge={() => void mergeSelectedPr()}
          merging={merging}
          capabilities={selectedConn?.capabilities}
          currentUserName={selectedConn?.user?.name ?? null}
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
          llmConfigured={llmConfigured}
          maxConcurrency={boot.config.pr_agent.max_concurrency}
          onOpenSettings={() => setShowSettings(true)}
          onJumpToDraftEditor={(t) => setPendingDiffNav(t)}
          onNavigateToAnchor={(anchor) => setPendingDiffNav({ anchor })}
          onSetReviewStatus={(s) => void setSelectedPrStatus(s)}
          // 当前 active LLM profile.model — RunningView 显示成 chip 让用户知道
          // 这次 review 用的什么模型 (不同 profile 出的结果差异大)
          currentLlmModel={
            boot.config.llm.profiles.find((p) => p.id === boot.config.llm.active_id)?.model ?? null
          }
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
        updateInfo={updateInfo}
      />
      {showSettings && (
        <SettingsModal
          info={boot.info}
          paths={boot.paths}
          config={boot.config}
          onLlmChange={(llm) =>
            setBoot((b) => (b ? { ...b, config: { ...b.config, llm } } : b))
          }
          onProxyChange={(proxy) =>
            setBoot((b) => (b ? { ...b, config: { ...b.config, proxy } } : b))
          }
          onConnectionsChange={refreshBootAndPrs}
          onClose={() => setShowSettings(false)}
        />
      )}
      {toast && (
        <div
          className="app-toast app-toast-error"
          role="alert"
          onClick={() => setToast(null)}
          title="点击关闭"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
