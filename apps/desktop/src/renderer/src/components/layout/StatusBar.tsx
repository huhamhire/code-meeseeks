import { useTranslation } from 'react-i18next';
import type { ConnectionSummary } from '@meebox/ipc';
import type { Config, PrAgentStatus, UpdateCheckResult } from '@meebox/shared';
import { invoke } from '../../api';
import { PanelToggleIcon, SettingsIcon, StatusChip } from '../common';
import { PrAgentActiveChip } from '../features/chat/statusbar/PrAgentActiveChip';
import { AutopilotChip } from '../features/chat/statusbar/AutopilotChip';
import { LlmChip } from '../features/settings/statusbar/LlmChip';
import { UserChip } from '../features/settings/statusbar/UserChip';
import { LastSyncChip } from '../features/pr/statusbar/LastSyncChip';
import { RepoSyncChip } from '../features/pr/statusbar/RepoSyncChip';
import { PrsCountChip } from '../features/pr/statusbar/PrsCountChip';

interface StatusBarProps {
  prsCount: number;
  prAgent: PrAgentStatus | null;
  connections: ConnectionSummary[];
  llm: Config['llm'];
  refreshing: boolean;
  sidebarCollapsed: boolean;
  chatCollapsed: boolean;
  /** Poller's most recent completion time (ISO string); null means never synced */
  lastSyncAt: string | null;
  onToggleSidebar: () => void;
  onToggleChat: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** Switch the active LLM profile; the parent component does the actual persistence */
  onSwitchActiveLlm: (profileId: string) => void;
  /**
   * Jump to a given PR (used by the "pr-agent running" chip click). Nullable — when omitted the chip still
   * shows but is not clickable. The parent component can just pass `setSelectedId`
   */
  onJumpToPr?: (localId: string) => void;
  /** New version detected at startup; when non-null and hasUpdate, show the "new version" chip, clicking jumps to the download page. */
  updateInfo?: UpdateCheckResult | null;
  /** Whether AutoPilot is enabled (agent.autopilot.enabled); click to toggle, persisted by the parent component. */
  autopilotEnabled: boolean;
  onToggleAutopilot: () => void;
}

/**
 * pr-agent runtime chip: shows a red "unavailable" warning (actionable info) only when **unavailable** (error state).
 * The version number for the available case has been de-emphasized off the status bar and moved down to the "About"
 * page (see RuntimeSection), and is no longer rendered here, reducing steady-state noise.
 */
function PrAgentRuntimeChip({ status }: { status: PrAgentStatus }) {
  const { t } = useTranslation();
  if (status.available) return null;
  return (
    <StatusChip tone="err" title={status.attempts.map((a) => a.error).join('\n')}>
      {t('statusBar.prAgentUnavailable')}
    </StatusChip>
  );
}

/**
 * App status bar (thin shell): left side collapse button + sync / repo mirror / pr-agent runtime / PR count / user,
 * right side pr-agent activity / AutoPilot / LLM / update, and at the end chat collapse + settings. Each business chip
 * is provided by its owning feature (features/<x>/statusbar/); this component only does composition and layout.
 */
export function StatusBar({
  prsCount,
  prAgent,
  connections,
  llm,
  refreshing,
  sidebarCollapsed,
  chatCollapsed,
  lastSyncAt,
  onToggleSidebar,
  onToggleChat,
  onRefresh,
  onOpenSettings,
  onSwitchActiveLlm,
  onJumpToPr,
  updateInfo,
  autopilotEnabled,
  onToggleAutopilot,
}: StatusBarProps) {
  const { t } = useTranslation();
  return (
    <footer className="app-statusbar" role="contentinfo">
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? t('statusBar.expandSidebar') : t('statusBar.collapseSidebar')}
        aria-label={
          sidebarCollapsed ? t('statusBar.expandSidebar') : t('statusBar.collapseSidebar')
        }
        aria-pressed={!sidebarCollapsed}
      >
        <PanelToggleIcon side="left" collapsed={sidebarCollapsed} />
      </button>
      <LastSyncChip at={lastSyncAt} refreshing={refreshing} onRefresh={onRefresh} />
      {/* The repo currently being synced (cloning/fetching). Not rendered when idle */}
      <RepoSyncChip />
      {prAgent && <PrAgentRuntimeChip status={prAgent} />}
      <PrsCountChip count={prsCount} />
      <UserChip connections={connections} />
      <div className="statusbar-spacer" />
      {/* pr-agent activity / idle indicator. Hidden when pr-agent is unavailable (the runtime chip above already shows a red warning). */}
      {prAgent?.available && <PrAgentActiveChip onJumpToPr={onJumpToPr} />}
      <AutopilotChip enabled={autopilotEnabled} onToggle={onToggleAutopilot} />
      <LlmChip llm={llm} onSwitch={onSwitchActiveLlm} onOpenSettings={onOpenSettings} />
      {updateInfo?.hasUpdate && updateInfo.url && (
        <StatusChip
          className="statusbar-chip-update"
          title={t('statusBar.updateAvailableTitle', {
            latest: updateInfo.latestVersion ?? '',
            current: updateInfo.currentVersion,
          })}
          onClick={() => void invoke('app:openExternal', { url: updateInfo.url! })}
        >
          {t('statusBar.updateChipLabel', { latest: updateInfo.latestVersion })}
        </StatusChip>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleChat}
        title={chatCollapsed ? t('statusBar.expandChat') : t('statusBar.collapseChat')}
        aria-label={chatCollapsed ? t('statusBar.expandChatAria') : t('statusBar.collapseChatAria')}
        aria-pressed={!chatCollapsed}
      >
        <PanelToggleIcon side="right" collapsed={chatCollapsed} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        title={t('statusBar.settings')}
        aria-label={t('statusBar.settings')}
      >
        <SettingsIcon />
      </button>
    </footer>
  );
}
