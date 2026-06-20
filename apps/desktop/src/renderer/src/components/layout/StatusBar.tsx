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
  /** Poller 最近一次完成时间（ISO 字符串）；null 表示从未同步 */
  lastSyncAt: string | null;
  onToggleSidebar: () => void;
  onToggleChat: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** 切换 active LLM profile，由父组件做实际持久化 */
  onSwitchActiveLlm: (profileId: string) => void;
  /**
   * 跳到指定 PR (供"pr-agent 运行中"chip 点击使用)。可空 —— 不传时 chip 仍展示但
   * 不可点击。父组件传 `setSelectedId` 即可
   */
  onJumpToPr?: (localId: string) => void;
  /** 启动检测到的新版本；非空且 hasUpdate 时展示「新版本」chip，点击跳转下载页。 */
  updateInfo?: UpdateCheckResult | null;
  /** AutoPilot 是否启用（agent.autopilot.enabled）；点击切换，由父组件持久化。 */
  autopilotEnabled: boolean;
  onToggleAutopilot: () => void;
}

/** pr-agent 运行时 chip：只显示版本（可用）/「不可用」（错误态），属应用运行时级，留在 layout。 */
function PrAgentRuntimeChip({ status }: { status: PrAgentStatus }) {
  const { t } = useTranslation();
  if (status.available) {
    // chip 只显示 pr-agent 版本，不显示 strategy（embedded/local-cli 对用户无意义）；
    // embedded → `pr-agent 0.36.0` → 取 `0.36.0`；local-cli → help 首行截到首个空白前。
    const ver =
      status.strategy === 'embedded'
        ? status.version.replace(/^pr-agent\s+/, '')
        : status.version.split(/\s+/)[0] || status.version;
    return (
      <StatusChip tone="ok" title={`${status.strategy} · ${status.version}`}>
        {t('statusBar.prAgentVersion', { ver })}
      </StatusChip>
    );
  }
  return (
    <StatusChip tone="err" title={status.attempts.map((a) => a.error).join('\n')}>
      {t('statusBar.prAgentUnavailable')}
    </StatusChip>
  );
}

/**
 * 应用状态栏（薄壳）：左侧折叠按钮 + 同步 / 仓库镜像 / pr-agent 运行时 / PR 计数 / 用户，
 * 右侧 pr-agent 活动 / AutoPilot / LLM / 更新，末尾 chat 折叠 + 设置。各业务 chip 由其所属
 * feature 提供（features/<x>/statusbar/），本组件只做组合与布局。
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
      {/* 当前正在 sync 的 repo (clone/fetch 中)。idle 不渲染 */}
      <RepoSyncChip />
      {prAgent && <PrAgentRuntimeChip status={prAgent} />}
      <PrsCountChip count={prsCount} />
      <UserChip connections={connections} />
      <div className="statusbar-spacer" />
      {/* pr-agent 活动 / 空闲指示。pr-agent 不可用时不显示（上方运行时 chip 已红色提示）。 */}
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
