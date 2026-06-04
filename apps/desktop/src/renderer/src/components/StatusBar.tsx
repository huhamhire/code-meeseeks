import { useEffect, useRef, useState } from 'react';
import type { Config, ConnectionSummary, PrAgentStatus } from '@meebox/shared';
import { invoke } from '../api';
import { useChatRunStore } from '../stores/chat-run-store';
import { useRepoSyncStore } from '../stores/repo-sync-store';

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
  onJumpToPr,
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
      <LastSyncChip at={lastSyncAt} refreshing={refreshing} onRefresh={onRefresh} />
      {/* 当前正在 sync 的 repo (clone/fetch 中)。idle 不渲染，活动时实时显示阶段 +
          百分比，让用户感知"agent 正在更新仓库镜像"而不是 hang */}
      <RepoSyncChip />
      {prAgent && <PrAgentChip status={prAgent} />}
      <span
        className="statusbar-chip statusbar-chip-ok statusbar-chip-prs"
        title={`待审 PR 数：${String(prsCount)}`}
        aria-label={`PRs ${String(prsCount)}`}
      >
        <PullRequestIcon />
        {prsCount}
      </span>
      <UserChip connections={connections} />
      <div className="spacer" />
      {/* pr-agent 活动 / 空闲指示。PR 切换后这条仍然在，让用户随时看到"agent 在哪个 PR
          上跑 / 当前空闲"。放右侧贴近 LLM chip：一组都是"当前 run 用什么 / 跑得如何"的实时
          信息。pr-agent 不可用时不显示 (上方 PrAgentChip 已经红色提示) */}
      {prAgent?.available && <PrAgentActiveChip onJumpToPr={onJumpToPr} />}
      <LlmChip llm={llm} onSwitch={onSwitchActiveLlm} onOpenSettings={onOpenSettings} />
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleChat}
        title={chatCollapsed ? '展开 PR Agent chat' : '收起 PR Agent chat'}
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
 * Repo sync 活动 chip：显示当前正在 clone/fetch 的 repo + 阶段 + 百分比。
 * 队列里只有一条在跑 (RepoMirrorManager 全局单队列)；store 收着多条时只展示首条。
 * idle 不渲染，避免占状态栏宽度。
 */
function RepoSyncChip() {
  const { active } = useRepoSyncStore();
  if (active.size === 0) return null;
  // Map 没保证迭代序，但 sync 同时只跑一个，多于一个时按 startedAt 升序选最早的
  const snapshots = Array.from(active.values()).sort((a, b) => a.startedAt - b.startedAt);
  const cur = snapshots[0]!;
  const more = snapshots.length - 1;
  // repo = "host/projectKey/repoSlug"，UI 紧凑只展示最后一段
  const shortRepo = cur.repo.split('/').slice(-1)[0] ?? cur.repo;
  const stageLabel = cur.stage ? `${cur.stage}` : '同步中';
  const pct = typeof cur.percent === 'number' ? ` ${String(Math.round(cur.percent))}%` : '';
  const queueSuffix = more > 0 ? ` (+${String(more)})` : '';
  return (
    <span
      className="statusbar-chip statusbar-repo-sync-chip"
      title={`${cur.repo} · ${stageLabel}${pct}${cur.message ? `\n${cur.message}` : ''}`}
    >
      <span className="statusbar-pragent-dot" aria-hidden="true" />
      <span className="statusbar-repo-sync-name">{shortRepo}</span>
      <span className="statusbar-repo-sync-progress muted">
        {stageLabel}
        {pct}
        {queueSuffix}
      </span>
    </span>
  );
}

/**
 * pr-agent 活动状态 chip：active 时显示运行中工具 + elapsed (可点跳 PR)；idle 时
 * 显示"空闲"占位。PR 切换不会丢运行中状态，由 chatRunStore 跨实例维护。
 *
 * 调用方应在 pr-agent 实际可用 (PrAgentStatus.available) 时才挂这条；不可用 (本机
 * CLI / Docker 都没探到) 时由 PrAgentChip 显示错误态，这里不重复"空闲"语义
 */
function PrAgentActiveChip({ onJumpToPr }: { onJumpToPr?: (localId: string) => void }) {
  const { active, waiting } = useChatRunStore();
  // 计时器：1s 粒度，跟 ChatPane 的 elapsed 同步。仅 active 时启
  const [elapsedMs, setElapsedMs] = useState(0);
  // startedAt 入队时为 null，executeRun 起跑时设值；fallback 到 enqueuedAt 即可
  const startMs = active ? new Date(active.startedAt ?? active.enqueuedAt).getTime() : 0;
  useEffect(() => {
    if (!active) return;
    setElapsedMs(Date.now() - startMs);
    const id = setInterval(() => setElapsedMs(Date.now() - startMs), 1000);
    return () => clearInterval(id);
  }, [active?.runId, startMs]);

  // 队列弹出菜单：点开 (active chip + 队列 ≥1) 显示 waiting 列表 + × 取消
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!queueOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!queueRef.current?.contains(e.target as Node)) setQueueOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setQueueOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [queueOpen]);
  // active 没了 / 队列空了 → 自动收起菜单
  useEffect(() => {
    if (queueOpen && waiting.length === 0 && !active) setQueueOpen(false);
  }, [queueOpen, waiting.length, active]);

  const handleCancelQueued = (runId: string): void => {
    void invoke('pragent:cancel', { runId });
  };

  if (!active) {
    // Idle：静态灰点 + "空闲" 文案。让用户一眼看到"agent 可用 + 当前没活儿"
    return (
      <span
        className="statusbar-chip statusbar-pragent-chip statusbar-pragent-chip-idle"
        title="PR Agent 当前空闲"
      >
        <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
        <span>空闲</span>
      </span>
    );
  }

  // 队列 ≥1 → chip 变 button (点开弹队列菜单)；否则按 onJumpToPr 走原 chip 行为
  const hasQueue = waiting.length > 0;
  const clickable = hasQueue || Boolean(onJumpToPr);
  const handleClick = (): void => {
    if (hasQueue) {
      setQueueOpen((v) => !v);
    } else {
      onJumpToPr?.(active.prLocalId);
    }
  };
  const title = hasQueue
    ? `PR Agent 运行中 · ${String(waiting.length)} 个排队中 · 点击查看队列`
    : `PR Agent 运行中 · PR ${active.prLocalId} · /${active.tool}${clickable ? ' · 点击跳转到该 PR' : ''}`;
  const inner = (
    <>
      <span className="statusbar-pragent-dot" aria-hidden="true" />
      <span>/{active.tool}</span>
      <span className="statusbar-pragent-elapsed">{formatStatusbarElapsed(elapsedMs)}</span>
      {hasQueue && (
        <span className="statusbar-pragent-queue-count" aria-label={`${String(waiting.length)} 个排队`}>
          +{waiting.length}
        </span>
      )}
    </>
  );

  return (
    <div className="statusbar-pragent-chip-wrap" ref={queueRef}>
      {clickable ? (
        <button
          type="button"
          className={`statusbar-chip statusbar-pragent-chip${queueOpen ? ' active' : ''}`}
          onClick={handleClick}
          title={title}
        >
          {inner}
        </button>
      ) : (
        <span className="statusbar-chip statusbar-pragent-chip" title={title}>
          {inner}
        </span>
      )}
      {queueOpen && hasQueue && (
        <QueuePopover
          active={active}
          waiting={waiting}
          onCancel={handleCancelQueued}
          onJumpToPr={(id) => {
            onJumpToPr?.(id);
            setQueueOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * 队列弹出菜单：状态栏 chip 上方弹出。第 1 条 active 行 + 余下 waiting 行。
 * waiting 行右侧 × 按钮取消。最多 6 个 item 高度，超出内部滚动。
 */
function QueuePopover({
  active,
  waiting,
  onCancel,
  onJumpToPr,
}: {
  active: NonNullable<ReturnType<typeof useChatRunStore>['active']>;
  waiting: ReturnType<typeof useChatRunStore>['waiting'];
  onCancel: (runId: string) => void;
  onJumpToPr: (localId: string) => void;
}) {
  return (
    <div className="statusbar-queue-popover" role="menu" aria-label="PR Agent 任务队列">
      <div className="statusbar-queue-header">
        <span className="muted">PR Agent 队列</span>
        <span className="muted">{waiting.length} 个排队</span>
      </div>
      <ul className="statusbar-queue-list">
        <li className="statusbar-queue-item statusbar-queue-item-active">
          <span className="statusbar-pragent-dot" aria-hidden="true" />
          <button
            type="button"
            className="statusbar-queue-meta"
            onClick={() => onJumpToPr(active.prLocalId)}
            title="点击跳转到该 PR"
          >
            <span className="statusbar-queue-tool">/{active.tool}</span>
            <code className="statusbar-queue-pr">{active.prLocalId}</code>
          </button>
          <span className="muted statusbar-queue-state">运行中</span>
        </li>
        {waiting.map((q) => (
          <li className="statusbar-queue-item" key={q.runId}>
            <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
            <button
              type="button"
              className="statusbar-queue-meta"
              onClick={() => onJumpToPr(q.prLocalId)}
              title="点击跳转到该 PR"
            >
              <span className="statusbar-queue-tool">/{q.tool}</span>
              <code className="statusbar-queue-pr">{q.prLocalId}</code>
            </button>
            <span className="muted statusbar-queue-state">排队中</span>
            <button
              type="button"
              className="statusbar-queue-cancel"
              onClick={() => onCancel(q.runId)}
              title="从队列移除"
              aria-label="取消"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 状态栏 elapsed 格式：跟 ChatPane.RunResultView 的 `formatElapsed` 对齐 ——
 *   < 60s   → "Ns"     (例 "42s")
 *   >= 60s  → "Mm SSs" (例 "1m 30s")，秒数两位补零定宽
 * 用 `m` / `s` 单位字面而不是 colon，避免跟时间戳 (HH:MM) 视觉混淆
 */
function formatStatusbarElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${String(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}m${String(s).padStart(2, '0')}s`;
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
        className={`statusbar-chip statusbar-llm-chip${empty ? '' : ' statusbar-llm-chip-active'}`}
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

// 刷新按钮 + 同步状态合并：一个可点击 chip，显示最近同步相对时间 + 同步图标
// （刷新中旋转），点击触发一次轮询。
function LastSyncChip({
  at,
  refreshing,
  onRefresh,
}: {
  at: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  // 每 30s 重渲染一次，让 "刚刚 / N 分钟前" 文案随时间向前推进
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const date = at ? new Date(at) : null;
  const label = refreshing ? '刷新中…' : date ? formatRelative(date) : '—';
  const title = refreshing
    ? '刷新中…'
    : date
      ? `最近同步：${date.toLocaleString()} · 点击刷新`
      : '尚未同步 · 点击刷新';
  return (
    <button
      type="button"
      className={`statusbar-chip statusbar-chip-sync statusbar-sync-btn${
        refreshing ? ' icon-btn-spinning' : ''
      }`}
      onClick={onRefresh}
      disabled={refreshing}
      title={title}
      aria-label="刷新（触发一次轮询）"
    >
      <SyncIcon />
      {label}
    </button>
  );
}

// 同步图标 (Lucide refresh-cw-2 风格)：两段相反方向的曲线箭头形成"循环"语义。
// 跟刷新按钮的 RefreshIcon (单根近似闭环箭头) 视觉区分 —— 一个表"状态/已同步"，
// 一个表"重新触发同步动作"
function SyncIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 上半圈：左下→右上的箭头 */}
      <path d="M3 6.5a5 5 0 0 1 9-1.5" />
      <polyline points="12 2 12 5 9 5" />
      {/* 下半圈：右上→左下的箭头 */}
      <path d="M13 9.5a5 5 0 0 1-9 1.5" />
      <polyline points="4 14 4 11 7 11" />
    </svg>
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
    // chip 只显示 pr-agent 版本，不显示 strategy（embedded/docker/local-cli 对用户无意义；
    // 完整 strategy + version 放 hover title）。version 来自 detect：
    // - docker → pinned image tag `pragent/pr-agent:0.36.0` → 取 `0.36.0`
    // - embedded → `pr-agent 0.36.0` → 取 `0.36.0`
    // - local-cli → `pr-agent --help` 首行，截到首个空白前（避免长 usage 撑爆 chip）
    const ver =
      status.strategy === 'docker'
        ? (status.version.split(':').pop() ?? status.version)
        : status.strategy === 'embedded'
          ? status.version.replace(/^pr-agent\s+/, '')
          : status.version.split(/\s+/)[0] || status.version;
    // 按 strategy 上色：embedded / local-cli 绿（statusbar-chip-ok），docker 蓝
    const colorClass =
      status.strategy === 'docker' ? 'statusbar-chip-docker' : 'statusbar-chip-ok';
    return (
      <span
        className={`statusbar-chip ${colorClass}`}
        title={`${status.strategy} · ${status.version}`}
      >
        PR Agent: {ver}
      </span>
    );
  }
  return (
    <span
      className="statusbar-chip statusbar-chip-err"
      title={status.attempts.map((a) => a.error).join('\n')}
    >
      PR Agent: unavailable
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

// Octicon git-pull-request 风格：源分支圆点 → 弯到右侧 → 目标分支带箭头。
// 两节点 + 弧形连接，跟 GitHub 状态徽章对齐，用户一眼能识别"PR"
function PullRequestIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 左侧分支竖线 */}
      <line x1="4" y1="4.5" x2="4" y2="11.5" />
      {/* 源分支圆点 (顶) */}
      <circle cx="4" cy="3" r="1.5" />
      {/* 源分支圆点 (底) */}
      <circle cx="4" cy="13" r="1.5" />
      {/* 右侧目标分支圆点 + 短线 */}
      <circle cx="12" cy="13" r="1.5" />
      <line x1="12" y1="4.5" x2="12" y2="11.5" />
      {/* 顶部弧线：从 4,1 经过 12,1 落到 12,4 (合并目标分支的"头") */}
      <path d="M5.5 3 H10.5 A1.5 1.5 0 0 1 12 4.5" />
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
