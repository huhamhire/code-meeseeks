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
  // PR list / selection / approve / merge / refresh — domain logic lives in usePullRequests
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
  // App startup / global lifecycle (boot load, language, poll / focus refresh, wizard completion, connection hot-apply)
  const { boot, fatalError, lastSyncAt, needsOnboarding, completeOnboarding, refreshBootAndPrs, patchConfig } =
    useBootstrap({ setPrs, reloadPrs });
  // Layout state (left/right column widths / collapse), version update notice, store wiring, external link guard — each its own app-level hook
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
  // Appearance (global theme + editor font): sync from config to runtime store + font CSS variables. Use defaults before boot,
  // module import already pins the first-frame theme from the localStorage cache, switch to config theme once boot arrives.
  useEditorAppearanceSync(
    boot?.config.appearance ?? {
      editor_theme: 'auto',
      editor_font_family: '',
      editor_font_size: 14,
    },
  );
  // Global theme: subscribe to the store's theme, derive light / dark to write data-theme (drives the semantic palette) + derive chrome structural colors +
  // persist to localStorage; under the 'auto' theme follow the OS light/dark switch.
  useGlobalTheme();

  const [showSettings, setShowSettings] = useState(false);
  // Settings panel initial section (used by command palette deep links like "open About / Model"); default falls to 'general' in SettingsModal.
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | undefined>(undefined);
  const openSettings = useCallback((category?: SettingsCategory) => {
    setSettingsCategory(category);
    setShowSettings(true);
  }, []);
  // PR status filter (pending / all / conflict / mergeable etc.): lifted to App so the command palette can also drive it and a collapsed sidebar doesn't lose the selection.
  const [statusFilter, setStatusFilter] = useState<FilterKey>('pending');
  // The single-commit scope currently selected in the Diff view (reported by DiffView): serves as the implicit scope for chat commands (see ChatPane).
  // Dedupe by sha to avoid a re-render loop from DiffView passing a new object on every render.
  const [viewCommitScope, setViewCommitScope] = useState<ReviewRunCommitScope | null>(null);
  const handleViewCommitScope = useCallback((s: ReviewRunCommitScope | null) => {
    setViewCommitScope((prev) => (prev?.sha === s?.sha ? prev : s));
  }, []);
  // PR navigation / scope domain (discovery filters / active·archived switch / archived lazy load / open by URL / locate jump / notification-click navigation +
  // cross-component Diff·Tab jump intent) — domain logic lives in usePrNavigation; selection state / read status is still owned by usePullRequests.
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
  // macOS dock badge: total count of active PRs "@me / replied to me" awaiting response → main process writes it to the dock icon (system behavior, logic in useDockBadge).
  useDockBadge({
    prs,
    platform: boot?.info.platform,
    notifications: boot?.config.notifications,
  });
  const archived = scope === 'archived';
  // Status bar "PRs to review" count: only counts PRs that **need my review and I have not yet reviewed** (discovery=review-requested and localStatus=pending).
  // Cannot simply count localStatus==='pending' — PRs in categories like "created by me" have me as a non-reviewer, localStatus stays pending forever, inflating the count.
  // On platforms without discovery categories (a single "awaiting my review" discovery) discoveryFilters is empty, treated as review-requested.
  const pendingReviewCount = useMemo(
    () =>
      prs.filter(
        (p) =>
          p.localStatus === 'pending' &&
          (p.discoveryFilters.length === 0 || p.discoveryFilters.includes('review-requested')),
      ).length,
    [prs],
  );
  // "Can engage" determination for the closed scope: merged / still-open PRs allow adding comments + AI review; declined ones are browse-only. The active scope is always engageable.
  const canEngage = !archived || (selectedPr ? selectedPr.state !== 'declined' : false);

  // Window-level global shortcuts (F5 auto review / DevTools / view closed / Ctrl-Cmd+B·J layout toggles) — domain logic lives in useGlobalShortcuts.
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

  // Connection the selected PR belongs to: capability bits (approve-button downgrade) + current PAT user (to judge "is my own PR").
  const selectedConn = selectedPr
    ? boot.connections.find((c) => c.connectionId === selectedPr.connectionId)
    : undefined;
  // Has an active connection but LLM not configured → ChatPane shows a "configure to enable" hint and disables input
  const llmConfigured = boot.config.llm.profiles.some((p) => p.id === boot.config.llm.active_id);
  // Discovery category tabs are determined by the active connection's capabilities (GitHub four, Bitbucket two, others none).
  const activeConnSummary = boot.connections.find(
    (c) => c.connectionId === boot.config.active_connection_id,
  );
  const availableDiscoveryFilters = activeConnSummary?.capabilities.discoveryFilters ?? [];
  const showDiscoveryFilter = availableDiscoveryFilters.length > 0;
  // Whether the platform supports the needs_work ("needs changes") review state: GitHub / Bitbucket support it, GitLab (binary approval) does not.
  // Determines whether the "pending" status filter is kept under discovery categories other than "awaiting my review" (see Sidebar.visibleFilters).
  const supportsNeedsWork = activeConnSummary?.capabilities.reviewStatuses.includes('needsWork') ?? false;
  // The selected category may be invalid for the current platform after switching connections → fall back to the first available.
  const effectiveDiscoveryFilter = availableDiscoveryFilters.includes(discoveryFilter)
    ? discoveryFilter
    : availableDiscoveryFilters[0];
  // Status items selectable in the command palette "category filter": consistent with the sidebar — hide decision types (approved / needs changes) when discovery categories exist.
  const visibleStatusFilters = showDiscoveryFilter
    ? PR_STATUS_FILTERS.filter((f) => !DECISION_STATUS_FILTERS.has(f.value))
    : PR_STATUS_FILTERS;

  return (
    <div className="app">
      <TitleBar
        platform={boot.info.platform}
        title={selectedPr?.title}
        config={boot.config}
        // When not engageable (declined / no selection) the "run auto review" command should hide: pass null to close its when gate.
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
              // The closed scope has no unread concept, no need to advance the read watermark.
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
              // The closed scope hides PR lifecycle actions (merge / approve); declined / not-engageable further hides comment / draft writes.
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
        {/* ChatPane is always mounted, collapse is just CSS hiding: preserves the lifecycle of a running run (timers / runProgress subscription). */}
        <ChatPane
          pr={selectedPr}
          prAgent={boot.prAgent}
          width={chatWidth}
          onResize={setChatWidth}
          // When not engageable (declined / no selection) force-collapse the chat panel and hide the AI review entry; merged / still-open PRs can still add reviews.
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
          codeSuggestionLayout={boot.config.agent.strategy.code_suggestion_layout}
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
