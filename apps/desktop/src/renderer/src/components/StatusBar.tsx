import { useEffect, useState } from 'react';
import type { Config, ConnectionSummary, PrAgentStatus } from '@pr-pilot/shared';

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
}

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
}: StatusBarProps) {
  return (
    <footer className="app-statusbar" role="contentinfo">
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        aria-pressed={!sidebarCollapsed}
      >
        <SidebarIcon collapsed={sidebarCollapsed} />
      </button>
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
      <LastSyncChip at={lastSyncAt} />
      {prAgent && <PrAgentChip status={prAgent} />}
      <span className="statusbar-chip statusbar-chip-ok">PRs: {prsCount}</span>
      <UserChip connections={connections} />
      <div className="spacer" />
      <LlmChip llm={llm} onSwitch={onSwitchActiveLlm} onOpenSettings={onOpenSettings} />
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleChat}
        title={chatCollapsed ? '展开 pr-agent chat' : '收起 pr-agent chat'}
        aria-label={chatCollapsed ? '展开 chat' : '收起 chat'}
        aria-pressed={!chatCollapsed}
      >
        <ChatPanelIcon collapsed={chatCollapsed} />
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

/**
 * 当前 active LLM profile 概要。点击展开下拉，列出所有 profile 直接切换。
 * 未配置时显示 "LLM: 未配置"，点击直接打开设置。
 */
function LlmChip({
  llm,
  onSwitch,
  onOpenSettings,
}: {
  llm: Config['llm'];
  onSwitch: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 点外面关菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.llm-chip-menu') || target?.closest('.statusbar-llm-chip')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = llm.profiles.find((p) => p.id === llm.active_id);
  const empty = !active;
  const text = empty ? '未配置' : active.model || active.label || active.provider;
  const title = empty
    ? 'LLM 模型未配置；点击打开设置'
    : `LLM: ${active.label || '(未命名)'}\nprovider: ${active.provider}${
        active.model ? `\nmodel: ${active.model}` : ''
      }${active.base_url ? `\nbase_url: ${active.base_url}` : ''}`;

  const onClick = (): void => {
    if (empty || llm.profiles.length === 0) {
      onOpenSettings();
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <span className="statusbar-llm-wrap">
      <button
        type="button"
        className={`statusbar-chip statusbar-llm-chip${empty ? '' : ' statusbar-chip-ok'}`}
        title={title}
        onClick={onClick}
      >
        LLM: {text}
      </button>
      {open && (
        <div className="llm-chip-menu" role="menu">
          {llm.profiles.map((p) => {
            const isActive = p.id === llm.active_id;
            return (
              <button
                key={p.id}
                type="button"
                className={`llm-chip-menu-item${isActive ? ' active' : ''}`}
                onClick={() => {
                  onSwitch(p.id);
                  setOpen(false);
                }}
              >
                <span className="llm-chip-menu-tick" aria-hidden="true">
                  {isActive ? '✓' : ''}
                </span>
                <span className="llm-chip-menu-meta">
                  <span className="llm-chip-menu-title">
                    {p.label || `配置 ${p.id.slice(0, 4)}`}
                  </span>
                  <span className="muted llm-chip-menu-sub">
                    {p.provider}
                    {p.model ? ` · ${p.model}` : ''}
                  </span>
                </span>
              </button>
            );
          })}
          <div className="llm-chip-menu-divider" />
          <button
            type="button"
            className="llm-chip-menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <span className="llm-chip-menu-tick" aria-hidden="true" />
            <span className="muted">管理 LLM 模型…</span>
          </button>
        </div>
      )}
    </span>
  );
}

/** 镜像版 SidebarIcon：细条在右侧表示 chat 面板 */
function ChatPanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="9.5" y1="3" x2="9.5" y2="13" />
      {collapsed && <rect x="9.5" y="3" width="4.5" height="10" fill="currentColor" />}
    </svg>
  );
}

function LastSyncChip({ at }: { at: string | null }) {
  // 每 30s 重渲染一次，让 "刚刚 / N 分钟前" 文案随时间向前推进
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!at) {
    return (
      <span className="statusbar-chip" title="尚未完成首次同步">
        同步：—
      </span>
    );
  }
  const date = new Date(at);
  const title = `最近一次 PR 列表同步：${date.toLocaleString()}`;
  return (
    <span className="statusbar-chip" title={title}>
      同步：{formatRelative(date)}
    </span>
  );
}

function formatRelative(date: Date): string {
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 30) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  // 超过 1 天直接给绝对时间，避免 "3 天前" 这种模糊
  return date.toLocaleString();
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

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  // 矩形 + 左侧细条标识"侧栏"；collapsed 时细条变实心、矩形变阴影感
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" />
      {collapsed && <rect x="2" y="3" width="4.5" height="10" fill="currentColor" />}
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
