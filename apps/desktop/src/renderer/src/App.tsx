import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrDiscoveryFilter, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from './api';
import { formatBackendError } from './errors';
import { chatRunStore } from './stores/chat-run-store';
import { ChatPane } from './components/features/chat';
import { MainPane } from './components/layout/MainPane';
import { PrPanel, PrEmpty, usePullRequests } from './components/features/pr';
import { OnboardingWizard } from './components/features/onboarding';
import { SettingsModal, type SettingsCategory } from './components/features/settings';
import {
  Sidebar,
  FILTERS as PR_STATUS_FILTERS,
  DECISION_STATUS_FILTERS,
  type FilterKey,
} from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { TitleBar } from './components/layout/TitleBar';
import { useToast } from './hooks/useToast';
import { useBootstrap } from './hooks/useBootstrap';
import { useDockBadge } from './hooks/useDockBadge';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useUpdateNotice } from './hooks/useUpdateNotice';
import { useAppStores } from './hooks/useAppStores';
import { useExternalLinkGuard } from './hooks/useExternalLinkGuard';
import { useGlobalTheme, useEditorAppearanceSync } from './hooks/useTheme';

export default function App() {
  const { t } = useTranslation();
  const { toast, notifyError, dismiss: dismissToast } = useToast();
  // PR 列表 / 选中 / 审批 / 合并 / 刷新 —— 领域逻辑归 usePullRequests
  const {
    prs,
    setPrs,
    selectedId,
    setSelectedId,
    refreshing,
    merging,
    reloadPrs,
    triggerRefresh,
    setSelectedPrStatus,
    mergeSelectedPr,
    markRead,
  } = usePullRequests({ notifyError });
  // 应用启动 / 全局生命周期（boot 加载、语言、poll / focus 刷新、向导完成、连接热生效）
  const { boot, fatalError, lastSyncAt, needsOnboarding, completeOnboarding, refreshBootAndPrs, patchConfig } =
    useBootstrap({ setPrs, reloadPrs });
  // 布局态（左右两栏宽度 / 折叠）、版本更新提示、store 接线、外链防护——各自成 app 级 hook
  const {
    sidebarWidth,
    setSidebarWidth,
    sidebarCollapsed,
    setSidebarCollapsed,
    chatWidth,
    setChatWidth,
    chatCollapsed,
    setChatCollapsed,
  } = usePanelLayout();
  const updateInfo = useUpdateNotice();
  useAppStores();
  useExternalLinkGuard();
  // 外观（全局主题 + 编辑器字体）：跟随 config 同步到运行时 store + 字体 CSS 变量。boot 前用默认值，
  // 模块导入时已按 localStorage 缓存定下首帧主题，boot 到达后切到 config 主题。
  useEditorAppearanceSync(
    boot?.config.appearance ?? {
      editor_theme: 'auto',
      editor_font_family: '',
      editor_font_size: 14,
    },
  );
  // 全局主题：订阅 store 的主题，反推浅 / 深写 data-theme（驱动语义色板）+ 派生 chrome 结构色 +
  // 持久化 localStorage；'auto' 主题下跟随 OS 深浅切换。
  useGlobalTheme();

  const [showSettings, setShowSettings] = useState(false);
  // 设置面板初始分区（命令面板「打开关于 / 模型」等深链用）；缺省由 SettingsModal 落 'general'。
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | undefined>(undefined);
  const openSettings = useCallback((category?: SettingsCategory) => {
    setSettingsCategory(category);
    setShowSettings(true);
  }, []);
  /**
   * M4 跨组件跳转：ChatPane finding card 点"编辑" / PublishReviewModal anchor 点击 → 这里 set →
   * PrPanel 切到 Diff tab + 透传给 DiffView 做 scroll/highlight/(可选)open edit zone，消费完清空。
   */
  const [pendingDiffNav, setPendingDiffNav] = useState<{
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null>(null);
  // 通知点击 summary 评论 → 请求 PrPanel 切到「活动」对话标签（inline 评论走 pendingDiffNav）。
  const [pendingTab, setPendingTab] = useState<'activity' | null>(null);
  // GitHub 发现分类（运行时筛选，不持久化）；仅活动连接支持时在 PR 列表展示。
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  // PR 状态筛选（待处理 / 全部 / 冲突 / 可合并等）：提升到 App 以便命令面板亦可驱动、折叠侧栏不丢选择。
  const [statusFilter, setStatusFilter] = useState<FilterKey>('pending');
  // PR 列表范围：进行中（活跃）/ 已关闭（归档冷存储，懒加载、只读）。命令面板「查看已关闭」亦可驱动。
  const [scope, setScope] = useState<'active' | 'archived'>('active');
  const [archivedPrs, setArchivedPrs] = useState<StoredPullRequest[]>([]);
  // 归档冷存储拉取中：列表区据此显示 loading（归档规模大、可能慢；PaneLoading 自带 150ms 延迟，快路径不闪）。
  const [archivedLoading, setArchivedLoading] = useState(false);
  // 进入「已关闭」范围时懒加载归档冷存储（每次进入重取，纳入此后新归档的 PR）；离开不清，便于来回切。
  useEffect(() => {
    if (scope !== 'archived') return;
    let cancelled = false;
    setArchivedLoading(true);
    void invoke('prs:listArchived', undefined)
      .then((list) => {
        if (!cancelled) setArchivedPrs(list);
      })
      .finally(() => {
        if (!cancelled) setArchivedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);
  // macOS dock 角标：活跃 PR「@我 / 回复我」待回应总数 → 主进程落到 dock 图标（系统行为，逻辑见 useDockBadge）。
  useDockBadge({
    prs,
    platform: boot?.info.platform,
    notifications: boot?.config.notifications,
  });
  // 选发现分类（侧栏 tab / 命令面板）即回到「进行中」范围；「查看已关闭」切到归档范围。
  const selectDiscovery = useCallback((f: PrDiscoveryFilter) => {
    setScope('active');
    setDiscoveryFilter(f);
  }, []);
  const viewActive = useCallback(() => setScope('active'), []);
  const viewArchived = useCallback(() => setScope('archived'), []);
  // 当前发现分类的 ref：供 openPrByUrl 在稳定回调里读最新值，免得把 discoveryFilter 进依赖、频繁重建命令。
  const discoveryFilterRef = useRef(discoveryFilter);
  discoveryFilterRef.current = discoveryFilter;
  // 按 URL 打开当前平台 PR（命令面板「打开 URL」）：定位本地或拉取存档后切到对应范围并选中；失败弹 toast。
  const openPrByUrl = useCallback(
    async (url: string) => {
      try {
        const res = await invoke('prs:openByUrl', { url });
        setScope(res.location);
        if (res.location === 'archived') {
          // 归档范围（已存在归档 / 新拉取存档）需重载列表纳入目标 PR。
          setArchivedPrs(await invoke('prs:listArchived', undefined));
        } else if (
          // 活跃 PR：若当前发现分类不含它，落到包含它的分类，确保侧栏能展示并高亮（否则只剩详情显示、列表无选中）。
          res.discoveryFilters.length > 0 &&
          !res.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(res.discoveryFilters[0]!);
        }
        setSelectedId(res.localId);
        if (res.location === 'active') void markRead(res.localId);
      } catch (e) {
        notifyError(formatBackendError(e).title);
      }
    },
    [setSelectedId, markRead, notifyError],
  );

  // 活跃 PR 列表 ref：供通知点击在稳定订阅里读最新值，免得把 prs 进依赖、频繁重订阅。
  const prsRef = useRef(prs);
  prsRef.current = prs;
  // 状态栏运行指示点击 → 定位该 agent 任务所属 PR 并打开会话。任务运行期间该 PR 可能已被 poll 归档（任务不取消、
  // 仍在跑），故活跃列表里找不到时视为已归档：切归档范围 + 重载归档列表（覆盖「本 tick 刚归档、缓存未含」与
  // 「已在归档范围、setScope 同值不触发懒加载」两种情况）再选中。活跃命中则切活跃范围 + 必要时切到含它的发现分类
  // （确保侧栏展示并高亮）+ 标已读。
  const jumpToPr = useCallback(
    async (localId: string) => {
      const active = prsRef.current.find((p) => p.localId === localId);
      if (active) {
        setScope('active');
        if (
          active.discoveryFilters.length > 0 &&
          !active.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(active.discoveryFilters[0]!);
        }
        setSelectedId(localId);
        void markRead(localId);
        return;
      }
      setScope('archived');
      setArchivedPrs(await invoke('prs:listArchived', undefined));
      setSelectedId(localId);
    },
    [markRead, setSelectedId],
  );
  // 系统通知点击 → 导航：复用 jumpToPr 选中目标（活跃命中切活跃范围 + 必要时切到含它的发现分类 + 标已读；
  // 否则视为已归档 → 切归档范围、加载归档列表后选中），再按类型定位——inline 评论跳 Diff 行，summary 评论
  // （mention / reply）开「活动」标签，new_pr 仅选中。此前仅在活跃列表查找、找不到即忽略，会漏掉已归档 PR 的
  // 通知（如运行中任务的 PR 本 tick 刚被归档）；改走 jumpToPr 与状态栏跳转同一套活跃 / 归档定位逻辑。
  useEffect(() => {
    return subscribe('notification:activate', ({ localId, kind, anchor }) => {
      void jumpToPr(localId);
      if (anchor) {
        setPendingDiffNav({ anchor: { path: anchor.path, startLine: anchor.line, endLine: anchor.line } });
      } else if (kind === 'mention' || kind === 'reply') {
        setPendingTab('activity');
      }
    });
  }, [jumpToPr]);

  // 列表 / 详情数据源随范围切换：已关闭范围用归档列表，其余用活跃列表。选中 PR 从当前展示列表解析——
  // 切到归档范围时若原选中是活跃 PR 则解析不到、详情区回落空态，选归档项后再展示其详情。
  const archived = scope === 'archived';
  const displayedPrs = archived ? archivedPrs : prs;
  const selectedPr = displayedPrs.find((p) => p.localId === selectedId) ?? null;
  // 状态栏「待审 PR」计数：仅计**需我评审且本人尚未评审**的 PR（discovery=review-requested 且 localStatus=pending）。
  // 不能简单数 localStatus==='pending'——「我创建的」等分类的 PR 本人非评审人、localStatus 恒为 pending，会把计数撑大。
  // 无发现分类的平台（单一「待我评审」发现）discoveryFilters 为空，视作 review-requested。
  const pendingReviewCount = useMemo(
    () =>
      prs.filter(
        (p) =>
          p.localStatus === 'pending' &&
          (p.discoveryFilters.length === 0 || p.discoveryFilters.includes('review-requested')),
      ).length,
    [prs],
  );
  // 已关闭范围的「可参与」判定：合并 / 仍开放的 PR 可补充评论 + AI 评审；decline 仅浏览。活跃范围恒可参与。
  const canEngage = !archived || (selectedPr ? selectedPr.state !== 'declined' : false);

  // 选中 PR 的 ref：供 F5 快捷键在稳定监听里读最新值，免得每次切 PR 重订阅。
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // 不可参与（decline / 无选中）时 F5 自动评审等写操作一律忽略；ref 供稳定监听读实时值。
  const canEngageRef = useRef(canEngage);
  canEngageRef.current = canEngage;

  // 布局快捷键（窗口级，VS Code 风）：Ctrl/Cmd+B 切 PR 列表（左侧栏）、Ctrl/Cmd+J 切对话面板（右侧）、
  // F5 运行自动评审、DevTools。仅单修饰键的 B/J 排除 Shift/Alt（避开 Cmd+Shift+P）；preventDefault 压过默认。
  useEffect(() => {
    const isMac = boot?.info.platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // F5：对当前选中 PR 运行自动评审（与命令面板同逻辑：有选中 PR、且未在跑才触发——重入保护）
      if (k === 'f5') {
        const id = selectedIdRef.current;
        if (id && canEngageRef.current && !chatRunStore.getSnapshot().agentPrs.includes(id)) {
          e.preventDefault();
          void invoke('agent:run', { localId: id });
        }
        return;
      }
      // DevTools：mac ⌥⌘I / 其余 Ctrl+Shift+I（带 Shift/Alt，与下面单修饰键的 B/J 区分）
      if (k === 'i') {
        const devtools = isMac
          ? e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey
          : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
        if (devtools) {
          e.preventDefault();
          void invoke('app:openDevTools', undefined);
        }
        return;
      }
      // 查看已关闭（history）：mac ⌘⇧H（避开系统「隐藏应用」⌘H）/ 其余 Ctrl+H（浏览器历史惯例）
      if (k === 'h') {
        const wantArchived = isMac
          ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
        if (wantArchived) {
          e.preventDefault();
          viewArchived();
        }
        return;
      }
      // 单修饰键布局开关：Ctrl/Cmd+B（PR 列表）、Ctrl/Cmd+J（对话面板）
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (k === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (k === 'j') {
        e.preventDefault();
        setChatCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boot?.info.platform, setSidebarCollapsed, setChatCollapsed, viewArchived]);

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
        <p className="muted">{t('app.loading')}</p>
      </div>
    );
  }
  if (needsOnboarding) {
    return (
      <OnboardingWizard
        existingLlmProfiles={boot.config.llm.profiles}
        initialReposDir={boot.config.workspace.repos_dir}
        initialLanguage={boot.config.language}
        onComplete={completeOnboarding}
      />
    );
  }

  // 选中 PR 所属连接：能力位（审批按钮降级）+ 当前 PAT 用户（判「是否自己的 PR」）。
  const selectedConn = selectedPr
    ? boot.connections.find((c) => c.connectionId === selectedPr.connectionId)
    : undefined;
  // 有 active 连接但 LLM 未配置 → ChatPane 给出「需配置才能启用」提示并禁用输入
  const llmConfigured = boot.config.llm.profiles.some((p) => p.id === boot.config.llm.active_id);
  // 发现分类标签由活动连接的能力决定（GitHub 四类、Bitbucket 两类、其余无）。
  const activeConnSummary = boot.connections.find(
    (c) => c.connectionId === boot.config.active_connection_id,
  );
  const availableDiscoveryFilters = activeConnSummary?.capabilities.discoveryFilters ?? [];
  const showDiscoveryFilter = availableDiscoveryFilters.length > 0;
  // 平台是否支持 needs_work（「需修改」）评审态：GitHub / Bitbucket 支持、GitLab（二元审批）不支持。
  // 决定非「待我评审」发现分类下是否保留「待处理」状态筛选（见 Sidebar.visibleFilters）。
  const supportsNeedsWork = activeConnSummary?.capabilities.reviewStatuses.includes('needsWork') ?? false;
  // 选中的分类可能因切换连接而对当前平台无效 → 回落首个可用。
  const effectiveDiscoveryFilter = availableDiscoveryFilters.includes(discoveryFilter)
    ? discoveryFilter
    : availableDiscoveryFilters[0];
  // 命令面板「分类筛选」可选的状态项：与侧栏一致——有发现分类时隐藏决断类（通过 / 需修改）。
  const visibleStatusFilters = showDiscoveryFilter
    ? PR_STATUS_FILTERS.filter((f) => !DECISION_STATUS_FILTERS.has(f.value))
    : PR_STATUS_FILTERS;

  return (
    <div className="app">
      <TitleBar
        platform={boot.info.platform}
        title={selectedPr?.title}
        config={boot.config}
        // 不可参与（decline / 无选中）时「运行自动评审」命令应隐藏：以 null 关掉其 when 门控。
        selectedPrId={canEngage ? selectedId : null}
        patchConfig={patchConfig}
        openSettings={openSettings}
        toggleChatPanel={() => setChatCollapsed((c) => !c)}
        togglePrList={() => setSidebarCollapsed((c) => !c)}
        discoveryFilters={availableDiscoveryFilters}
        setDiscoveryFilter={selectDiscovery}
        prStatusFilters={visibleStatusFilters}
        setPrStatusFilter={setStatusFilter}
        viewArchived={viewArchived}
        openPrByUrl={openPrByUrl}
      />
      <div className="app-body">
        {!sidebarCollapsed && (
          <Sidebar
            prs={displayedPrs}
            selectedId={selectedId}
            onSelect={(pr) => {
              setSelectedId(pr.localId);
              // 已关闭范围无未读概念，无需推进已读水位。
              if (!archived) void markRead(pr.localId);
            }}
            width={sidebarWidth}
            onResize={setSidebarWidth}
            availableFilters={showDiscoveryFilter ? availableDiscoveryFilters : undefined}
            discoveryFilter={showDiscoveryFilter ? effectiveDiscoveryFilter : undefined}
            onDiscoveryFilterChange={showDiscoveryFilter ? selectDiscovery : undefined}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            scope={scope}
            onViewActive={viewActive}
            onViewArchived={viewArchived}
            loading={archived && archivedLoading}
            supportsNeedsWork={supportsNeedsWork}
          />
        )}
        <MainPane>
          {selectedPr ? (
            <PrPanel
              pr={selectedPr}
              onSetStatus={(s) => void setSelectedPrStatus(s)}
              onMerge={() => void mergeSelectedPr()}
              merging={merging}
              capabilities={selectedConn?.capabilities}
              currentUserName={selectedConn?.user?.name ?? null}
              // 已关闭范围隐藏 PR 生命周期操作（合并 / 审批）；decline / 不可参与再隐藏评论 / 草稿写入。
              hideLifecycle={archived}
              readOnly={!canEngage}
              pendingDiffNav={pendingDiffNav}
              onDiffNavConsumed={() => setPendingDiffNav(null)}
              onRequestDiffNav={(target) => setPendingDiffNav(target)}
              pendingTab={pendingTab}
              onPendingTabConsumed={() => setPendingTab(null)}
            />
          ) : (
            <PrEmpty hasConnections={boot.config.connections.length > 0} />
          )}
        </MainPane>
        {/* ChatPane 始终挂载，折叠只是 CSS 隐藏：保住运行中的 run 生命周期（计时器 / runProgress 订阅）。 */}
        <ChatPane
          pr={selectedPr}
          prAgent={boot.prAgent}
          width={chatWidth}
          onResize={setChatWidth}
          // 不可参与（decline / 无选中）时强制折叠对话面板、隐去 AI 评审入口；合并 / 仍开放 PR 仍可补评审。
          collapsed={chatCollapsed || !canEngage}
          llmConfigured={llmConfigured}
          onOpenSettings={() => setShowSettings(true)}
          onJumpToDraftEditor={(target) => setPendingDiffNav(target)}
          onNavigateToAnchor={(anchor) => setPendingDiffNav({ anchor })}
          onSetReviewStatus={(s) => void setSelectedPrStatus(s)}
          onMerge={() => void mergeSelectedPr()}
          currentLlmModel={
            boot.config.llm.profiles.find((p) => p.id === boot.config.llm.active_id)?.model ?? null
          }
        />
      </div>
      <StatusBar
        prsCount={pendingReviewCount}
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
          patchConfig((c) => ({ ...c, llm: next }));
        }}
        onJumpToPr={(id) => void jumpToPr(id)}
        updateInfo={updateInfo}
        autopilotEnabled={boot.config.agent.autopilot.enabled}
        onToggleAutopilot={() => {
          const enabled = !boot.config.agent.autopilot.enabled;
          void invoke('agent:setAutopilotEnabled', { enabled });
          patchConfig((c) => ({
            ...c,
            agent: { ...c.agent, autopilot: { ...c.agent.autopilot, enabled } },
          }));
        }}
      />
      {showSettings && (
        <SettingsModal
          info={boot.info}
          paths={boot.paths}
          config={boot.config}
          onLlmChange={(llm) => patchConfig((c) => ({ ...c, llm }))}
          onProxyChange={(proxy) => patchConfig((c) => ({ ...c, proxy }))}
          onLanguageChange={(language) => patchConfig((c) => ({ ...c, language }))}
          onEditorAppearanceChange={(appearance) =>
            patchConfig((c) => ({ ...c, appearance: { ...c.appearance, ...appearance } }))
          }
          onConnectionsChange={refreshBootAndPrs}
          onConfigPersisted={(config) => patchConfig(() => config)}
          initialCategory={settingsCategory}
          onClose={() => setShowSettings(false)}
        />
      )}
      {toast && (
        <div
          className="app-toast app-toast-error"
          role="alert"
          onClick={dismissToast}
          title={t('app.toastCloseTitle')}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
