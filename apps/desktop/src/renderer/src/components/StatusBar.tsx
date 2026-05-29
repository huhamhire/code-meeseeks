import type { ConnectionSummary, PrAgentStatus } from '@pr-pilot/shared';

interface StatusBarProps {
  prsCount: number;
  prAgent: PrAgentStatus | null;
  connections: ConnectionSummary[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

export function StatusBar({
  prsCount,
  prAgent,
  connections,
  refreshing,
  onRefresh,
  onOpenSettings,
}: StatusBarProps) {
  return (
    <footer className="app-statusbar" role="contentinfo">
      <span className="app-title">pr-pilot</span>
      <span className="statusbar-chip">M1-D</span>
      {prAgent && <PrAgentChip status={prAgent} />}
      <span className="statusbar-chip statusbar-chip-ok">PRs: {prsCount}</span>
      <UserChip connections={connections} />
      <div className="spacer" />
      <button
        type="button"
        className={`icon-btn ${refreshing ? 'icon-btn-spinning' : ''}`}
        onClick={onRefresh}
        disabled={refreshing}
        title={refreshing ? '刷新中…' : '刷新（触发一次轮询）'}
        aria-label="刷新"
      >
        <RefreshIcon />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
      >
        <SettingsIcon />
      </button>
    </footer>
  );
}

function PrAgentChip({ status }: { status: PrAgentStatus }) {
  if (status.available) {
    return (
      <span className="statusbar-chip statusbar-chip-ok" title={status.version}>
        pr-agent: {status.strategy}
      </span>
    );
  }
  return (
    <span
      className="statusbar-chip statusbar-chip-err"
      title={status.attempts.map((a) => a.error).join('\n')}
    >
      pr-agent: unavailable
    </span>
  );
}

function UserChip({ connections }: { connections: ConnectionSummary[] }) {
  const labels = connections
    .filter((c) => c.user)
    .map((c) =>
      connections.length > 1 ? `${c.displayName}: ${c.user!.displayName}` : c.user!.displayName,
    );
  if (labels.length === 0) return null;
  const title = connections
    .map(
      (c) => `${c.displayName}: ${c.user ? `${c.user.displayName} (${c.user.name})` : '未识别'}`,
    )
    .join('\n');
  return (
    <span className="statusbar-user" title={title}>
      <UserIcon />
      {labels.join(' · ')}
    </span>
  );
}

function UserIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-3.51-7.13" />
      <polyline points="21 4 21 10 15 10" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
