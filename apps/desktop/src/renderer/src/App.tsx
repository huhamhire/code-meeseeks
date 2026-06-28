import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrDiscoveryFilter, StoredPullRequest } from '@meebox/shared';
import { invoke } from './api';
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
  // GitHub 发现分类（运行时筛选，不持久化）；仅活动连接支持时在 PR 列表展示。
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  // PR 状态筛选（待处理 / 全部 / 冲突 / 可合并等）：提升到 App 以便命令面板亦可驱动、折叠侧栏不丢选择。
  const [statusFilter, setStatusFilter] = useState<FilterKey>('pending');
  // PR 列表范围：进行中（活跃）/ 已关闭（归档冷存储，懒加载、只读）。命令面板「查看已关闭」亦可驱动。
  const [scope, setScope] = useState<'active' | 'archived'>('active');
  const [archivedPrs, setArchivedPrs] = useState<StoredPullRequest[]>([]);
  // 进入「已关闭」范围时懒加载归档冷存储（每次进入重取，纳入此后新归档的 PR）；离开不清，便于来回切。
  useEffect(() => {
    if (scope !== 'archived') return;
    let cancelled = false;
    void invoke('prs:listArchived', undefined).then((list) => {
      if (!cancelled) setArchivedPrs(list);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);
  // 选发现分类（侧栏 tab / 命令面板）即回到「进行中」范围；「查看已关闭」切到归档范围。
  const selectDiscovery = useCallback((f: PrDiscoveryFilter) => {
    setScope('active');
    setDiscoveryFilter(f);
  }, []);
  const viewActive = useCallback(() => setScope('active'), []);
  const viewArchived = useCallback(() => setScope('archived'), []);

  // 选中 PR 的 ref：供 F5 快捷键在稳定监听里读最新值，免得每次切 PR 重订阅。
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // 已关闭（归档）范围为只读：F5 自动评审等写操作在此范围下一律忽略；ref 供稳定监听读实时值。
  const readOnlyRef = useRef(scope === 'archived');
  readOnlyRef.current = scope === 'archived';

  // 布局快捷键（窗口级，VS Code 风）：Ctrl/Cmd+B 切 PR 列表（左侧栏）、Ctrl/Cmd+J 切对话面板（右侧）、
  // F5 运行自动评审、DevTools。仅单修饰键的 B/J 排除 Shift/Alt（避开 Cmd+Shift+P）；preventDefault 压过默认。
  useEffect(() => {
    const isMac = boot?.info.platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // F5：对当前选中 PR 运行自动评审（与命令面板同逻辑：有选中 PR、且未在跑才触发——重入保护）
      if (k === 'f5') {
        const id = selectedIdRef.current;
        if (id && !readOnlyRef.current && !chatRunStore.getSnapshot().agentPrs.includes(id)) {
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
  }, [boot?.info.platform, setSidebarCollapsed, setChatCollapsed]);

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

  // 列表 / 详情数据源随范围切换：已关闭范围用归档列表（只读），其余用活跃列表。选中 PR 从当前展示
  // 列表解析——切到归档范围时若原选中是活跃 PR 则解析不到、详情区回落空态，选归档项后再展示其详情。
  const readOnly = scope === 'archived';
  const displayedPrs = readOnly ? archivedPrs : prs;
  const selectedPr = displayedPrs.find((p) => p.localId === selectedId) ?? null;
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
        // 已关闭范围下「运行自动评审」命令应隐藏（只读）：以 null 关掉其 when 门控。
        selectedPrId={readOnly ? null : selectedId}
        patchConfig={patchConfig}
        openSettings={openSettings}
        toggleChatPanel={() => setChatCollapsed((c) => !c)}
        togglePrList={() => setSidebarCollapsed((c) => !c)}
        discoveryFilters={availableDiscoveryFilters}
        setDiscoveryFilter={selectDiscovery}
        prStatusFilters={visibleStatusFilters}
        setPrStatusFilter={setStatusFilter}
        viewArchived={viewArchived}
      />
      <div className="app-body">
        {!sidebarCollapsed && (
          <Sidebar
            prs={displayedPrs}
            selectedId={selectedId}
            onSelect={(pr) => {
              setSelectedId(pr.localId);
              // 已关闭范围只读、无未读概念，无需推进已读水位。
              if (!readOnly) void markRead(pr.localId);
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
              readOnly={readOnly}
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
          pr={selectedPr}
          prAgent={boot.prAgent}
          width={chatWidth}
          onResize={setChatWidth}
          // 已关闭范围为只读：强制折叠对话面板（评审工具对已完成 PR 无意义），运行入口一并隐去。
          collapsed={chatCollapsed || readOnly}
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
