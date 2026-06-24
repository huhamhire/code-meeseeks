import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrDiscoveryFilter } from '@meebox/shared';
import { invoke } from './api';
import { ChatPane } from './components/features/chat';
import { MainPane } from './components/layout/MainPane';
import { PrPanel, PrEmpty, usePullRequests } from './components/features/pr';
import { OnboardingWizard } from './components/features/onboarding';
import { SettingsModal } from './components/features/settings';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { TitleBar } from './components/layout/TitleBar';
import { useToast } from './hooks/useToast';
import { useBootstrap } from './hooks/useBootstrap';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useUpdateNotice } from './hooks/useUpdateNotice';
import { useAppStores } from './hooks/useAppStores';
import { useExternalLinkGuard } from './hooks/useExternalLinkGuard';
import { useTheme, useEditorAppearanceSync } from './hooks/useTheme';

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
  // GUI 主题：跟随 config 偏好生效（'system' 下还跟随 OS 切换）。boot 前用默认深色，模块导入时已按
  // localStorage 缓存定下首帧主题，boot 到达后切到 config 偏好。
  useTheme(boot?.config.appearance.theme ?? 'dark');
  // 编辑器外观（Monaco 主题 + 等宽字体）：跟随 config 同步到运行时 store + 字体 CSS 变量。
  useEditorAppearanceSync(
    boot?.config.appearance ?? { theme: 'dark', editor_theme: 'auto', editor_font_family: '' },
  );

  const [showSettings, setShowSettings] = useState(false);
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

  return (
    <div className="app">
      <TitleBar platform={boot.info.platform} title={selected?.title} />
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
          onThemeChange={(theme) =>
            patchConfig((c) => ({ ...c, appearance: { ...c.appearance, theme } }))
          }
          onEditorAppearanceChange={(appearance) =>
            patchConfig((c) => ({ ...c, appearance: { ...c.appearance, ...appearance } }))
          }
          onConnectionsChange={refreshBootAndPrs}
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
