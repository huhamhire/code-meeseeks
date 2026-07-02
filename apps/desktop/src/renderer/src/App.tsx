import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRunCommitScope } from '@meebox/shared';
import { invoke } from './api';
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
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { usePrNavigation } from './hooks/usePrNavigation';
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
  // PR 状态筛选（待处理 / 全部 / 冲突 / 可合并等）：提升到 App 以便命令面板亦可驱动、折叠侧栏不丢选择。
  const [statusFilter, setStatusFilter] = useState<FilterKey>('pending');
  // 当前 Diff 视图选中的单 commit 范围（DiffView 上报）：作为聊天区命令的隐式范围（见 ChatPane）。
  // 按 sha 去重，避免 DiffView 每次 render 传新对象引发的重渲染回环。
  const [viewCommitScope, setViewCommitScope] = useState<ReviewRunCommitScope | null>(null);
  const handleViewCommitScope = useCallback((s: ReviewRunCommitScope | null) => {
    setViewCommitScope((prev) => (prev?.sha === s?.sha ? prev : s));
  }, []);
  // PR 导航 / 范围领域（发现分类 / 活跃·归档切换 / 归档懒加载 / 按 URL 打开 / 定位跳转 / 通知点击导航 +
  // 跨组件 Diff·Tab 跳转意图）——领域逻辑归 usePrNavigation；选中态 / 已读仍由 usePullRequests 拥有。
  const {
    scope,
    discoveryFilter,
    displayedPrs,
    selectedPr,
    archivedLoading,
    selectDiscovery,
    viewActive,
    viewArchived,
    openPrByUrl,
    jumpToPr,
    pendingDiffNav,
    setPendingDiffNav,
    pendingTab,
    setPendingTab,
  } = usePrNavigation({ prs, selectedId, setSelectedId, markRead, notifyError });
  // macOS dock 角标：活跃 PR「@我 / 回复我」待回应总数 → 主进程落到 dock 图标（系统行为，逻辑见 useDockBadge）。
  useDockBadge({
    prs,
    platform: boot?.info.platform,
    notifications: boot?.config.notifications,
  });
  const archived = scope === 'archived';
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

  // 窗口级全局快捷键（F5 自动评审 / DevTools / 查看已关闭 / Ctrl-Cmd+B·J 布局开关）——领域逻辑归 useGlobalShortcuts。
  useGlobalShortcuts({
    platform: boot?.info.platform,
    selectedId,
    canEngage,
    viewArchived,
    setSidebarCollapsed,
    setChatCollapsed,
  });

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
            activePrs={prs}
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
              onViewCommitScopeChange={handleViewCommitScope}
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
          viewCommitScope={viewCommitScope}
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
