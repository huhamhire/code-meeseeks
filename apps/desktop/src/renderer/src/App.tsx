import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrDiscoveryFilter } from '@meebox/shared';
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
    selected,
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
  // GitHub 发现分类（运行时筛选，不持久化）；仅活动连接支持时在 PR 列表展示。
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  // PR 状态筛选（待处理 / 全部 / 冲突 / 可合并等）：提升到 App 以便命令面板亦可驱动、折叠侧栏不丢选择。
  const [statusFilter, setStatusFilter] = useState<FilterKey>('pending');

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
  const selectedConn = selected
    ? boot.connections.find((c) => c.connectionId === selected.connectionId)
    : undefined;
  // 有 active 连接但 LLM 未配置 → ChatPane 给出「需配置才能启用」提示并禁用输入
  const llmConfigured = boot.config.llm.profiles.some((p) => p.id === boot.config.llm.active_id);
  // 发现分类标签由活动连接的能力决定（GitHub 四类、Bitbucket 两类、其余无）。
  const activeConnSummary = boot.connections.find(
    (c) => c.connectionId === boot.config.active_connection_id,
  );
  const availableDiscoveryFilters = activeConnSummary?.capabilities.discoveryFilters ?? [];
  const showDiscoveryFilter = availableDiscoveryFilters.length > 0;
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
        title={selected?.title}
        config={boot.config}
        selectedPrId={selectedId}
        patchConfig={patchConfig}
        openSettings={openSettings}
        toggleChatPanel={() => setChatCollapsed((c) => !c)}
        togglePrList={() => setSidebarCollapsed((c) => !c)}
        discoveryFilters={availableDiscoveryFilters}
        setDiscoveryFilter={setDiscoveryFilter}
        prStatusFilters={visibleStatusFilters}
        setPrStatusFilter={setStatusFilter}
      />
      <div className="app-body">
        {!sidebarCollapsed && (
          <Sidebar
            prs={prs}
            selectedId={selectedId}
            onSelect={(pr) => {
              setSelectedId(pr.localId);
              void markRead(pr.localId);
            }}
            width={sidebarWidth}
            onResize={setSidebarWidth}
            availableFilters={showDiscoveryFilter ? availableDiscoveryFilters : undefined}
            discoveryFilter={showDiscoveryFilter ? effectiveDiscoveryFilter : undefined}
            onDiscoveryFilterChange={showDiscoveryFilter ? setDiscoveryFilter : undefined}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
          />
        )}
        <MainPane>
          {selected ? (
            <PrPanel
              pr={selected}
              onSetStatus={(s) => void setSelectedPrStatus(s)}
              onMerge={() => void mergeSelectedPr()}
              merging={merging}
              capabilities={selectedConn?.capabilities}
              currentUserName={selectedConn?.user?.name ?? null}
              pendingDiffNav={pendingDiffNav}
              onDiffNavConsumed={() => setPendingDiffNav(null)}
              onRequestDiffNav={(target) => setPendingDiffNav(target)}
            />
          ) : (
            <PrEmpty hasConnections={boot.config.connections.length > 0} />
          )}
        </MainPane>
        {/* ChatPane 始终挂载，折叠只是 CSS 隐藏：保住运行中的 run 生命周期（计时器 / runProgress 订阅）。 */}
        <ChatPane
          pr={selected}
          prAgent={boot.prAgent}
          width={chatWidth}
          onResize={setChatWidth}
          collapsed={chatCollapsed}
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
          patchConfig((c) => ({ ...c, llm: next }));
        }}
        onJumpToPr={setSelectedId}
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
