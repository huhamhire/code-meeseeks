import type { PrAgentStatus } from '@pr-pilot/shared';

interface HeaderProps {
  prsCount: number;
  prAgent: PrAgentStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

export function Header({ prsCount, prAgent, refreshing, onRefresh, onOpenSettings }: HeaderProps) {
  return (
    <header className="app-header">
      <h1>pr-pilot</h1>
      <span className="badge">M1-D</span>
      {prAgent && <PrAgentBadge status={prAgent} />}
      <span className="badge badge-ok">PRs: {prsCount}</span>
      <div className="spacer" />
      <button className="btn" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? '刷新中…' : '刷新'}
      </button>
      <button className="btn" onClick={onOpenSettings}>
        设置
      </button>
    </header>
  );
}

function PrAgentBadge({ status }: { status: PrAgentStatus }) {
  if (status.available) {
    return (
      <span className="badge badge-ok" title={status.version}>
        pr-agent: {status.strategy}
      </span>
    );
  }
  return (
    <span className="badge badge-err" title={status.attempts.map((a) => a.error).join('\n')}>
      pr-agent: unavailable
    </span>
  );
}
