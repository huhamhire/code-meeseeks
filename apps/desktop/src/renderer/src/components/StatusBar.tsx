import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Config, ConnectionSummary, PrAgentStatus, UpdateCheckResult } from '@meebox/shared';
import { invoke } from '../api';
import { useChatRunStore } from '../stores/chat-run-store';
import { useRepoSyncStore } from '../stores/repo-sync-store';
import {
  PanelToggleIcon,
  PersonIcon,
  PullRequestIcon,
  SettingsIcon,
  SyncIcon,
} from './icons';

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
  updateInfo,
}: StatusBarProps) {
  const { t } = useTranslation();
  return (
    <footer className="app-statusbar" role="contentinfo">
      <button
        type="button"
        className="icon-btn"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? t('statusBar.expandSidebar') : t('statusBar.collapseSidebar')}
        aria-label={sidebarCollapsed ? t('statusBar.expandSidebar') : t('statusBar.collapseSidebar')}
        aria-pressed={!sidebarCollapsed}
      >
        <PanelToggleIcon side="left" collapsed={sidebarCollapsed} />
      </button>
      <LastSyncChip at={lastSyncAt} refreshing={refreshing} onRefresh={onRefresh} />
      {/* 当前正在 sync 的 repo (clone/fetch 中)。idle 不渲染，活动时实时显示阶段 +
          百分比，让用户感知"agent 正在更新仓库镜像"而不是 hang */}
      <RepoSyncChip />
      {prAgent && <PrAgentChip status={prAgent} />}
      <span
        className="statusbar-chip statusbar-chip-ok statusbar-chip-prs"
        title={t('statusBar.pendingPrsCount', { n: prsCount })}
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
      {updateInfo?.hasUpdate && updateInfo.url && (
        <button
          type="button"
          className="statusbar-chip statusbar-chip-update"
          title={t('statusBar.updateAvailableTitle', {
            latest: updateInfo.latestVersion ?? '',
            current: updateInfo.currentVersion,
          })}
          onClick={() => void invoke('app:openExternal', { url: updateInfo.url! })}
        >
          {t('statusBar.updateChipLabel', { latest: updateInfo.latestVersion })}
        </button>
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

/**
 * Repo sync 活动 chip：显示当前正在 clone/fetch 的 repo + 阶段 + 百分比。
 * 队列里只有一条在跑 (RepoMirrorManager 全局单队列)；store 收着多条时只展示首条。
 * idle 不渲染，避免占状态栏宽度。
 */
function RepoSyncChip() {
  const { t } = useTranslation();
  const { active } = useRepoSyncStore();
  if (active.size === 0) return null;
  // Map 没保证迭代序，但 sync 同时只跑一个，多于一个时按 startedAt 升序选最早的
  const snapshots = Array.from(active.values()).sort((a, b) => a.startedAt - b.startedAt);
  const cur = snapshots[0]!;
  const more = snapshots.length - 1;
  // repo = "host/projectKey/repoSlug"，UI 紧凑只展示最后一段
  const shortRepo = cur.repo.split('/').slice(-1)[0] ?? cur.repo;
  const stageLabel = cur.stage ? `${cur.stage}` : t('statusBar.syncing');
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
 * 调用方应在 pr-agent 实际可用 (PrAgentStatus.available) 时才挂这条；不可用 (嵌入式
 * 运行时 / 本机 CLI 都没探到) 时由 PrAgentChip 显示错误态，这里不重复"空闲"语义
 */
function PrAgentActiveChip({ onJumpToPr }: { onJumpToPr?: (localId: string) => void }) {
  const { t } = useTranslation();
  const { active, waiting } = useChatRunStore();
  // 并发模型：active 是运行中 run 列表。chip 主体展示第一条（primary）的 tool + elapsed，
  // 多于一条时用徽标显示并发总数；点开 popover 列出全部运行中 + 排队中。
  const primary = active[0] ?? null;
  const runningCount = active.length;
  // 计时器：1s 粒度，跟 ChatPane 的 elapsed 同步。仅有 primary 时启
  const [elapsedMs, setElapsedMs] = useState(0);
  // startedAt 入队时为 null，executeRun 起跑时设值；fallback 到 enqueuedAt 即可
  const startMs = primary ? new Date(primary.startedAt ?? primary.enqueuedAt).getTime() : 0;
  useEffect(() => {
    if (!primary) return;
    setElapsedMs(Date.now() - startMs);
    const id = setInterval(() => setElapsedMs(Date.now() - startMs), 1000);
    return () => clearInterval(id);
    // 仅依赖 primary runId + startMs：其它字段变化不影响计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.runId, startMs]);

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
  // 无可展开内容（无排队 且 运行中 ≤1）→ 自动收起菜单
  useEffect(() => {
    if (queueOpen && waiting.length === 0 && active.length <= 1) setQueueOpen(false);
  }, [queueOpen, waiting.length, active.length]);

  const handleCancelQueued = (runId: string): void => {
    void invoke('pragent:cancel', { runId });
  };

  if (!primary) {
    // Idle：静态灰点 + "空闲" 文案。让用户一眼看到"agent 可用 + 当前没活儿"
    return (
      <span
        className="statusbar-chip statusbar-pragent-chip statusbar-pragent-chip-idle"
        title={t('statusBar.prAgentIdleTitle')}
      >
        <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
        <span>{t('statusBar.idle')}</span>
      </span>
    );
  }

  // 可展开（运行中 >1 或有排队）→ chip 变 button 点开 popover；否则按 onJumpToPr 跳 PR。
  const expandable = waiting.length > 0 || runningCount > 1;
  const clickable = expandable || Boolean(onJumpToPr);
  const handleClick = (): void => {
    if (expandable) {
      setQueueOpen((v) => !v);
    } else {
      onJumpToPr?.(primary.prLocalId);
    }
  };
  // 徽标数 = 其它并发运行中(runningCount-1) + 排队中(waiting)
  const extraCount = runningCount - 1 + waiting.length;
  const title = expandable
    ? t('statusBar.prAgentExpandableTitle', { running: runningCount, waiting: waiting.length })
    : t('statusBar.prAgentRunningTitle', { pr: primary.prLocalId, tool: primary.tool }) +
      (clickable ? t('statusBar.jumpHint') : '');
  const inner = (
    <>
      <span className="statusbar-pragent-dot" aria-hidden="true" />
      <span>/{primary.tool}</span>
      <span className="statusbar-pragent-elapsed">{formatStatusbarElapsed(elapsedMs)}</span>
      {extraCount > 0 && (
        <span
          className="statusbar-pragent-queue-count"
          aria-label={t('statusBar.extraRunningAria', { n: extraCount })}
        >
          +{extraCount}
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
      {queueOpen && expandable && (
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
 * 队列弹出菜单：状态栏 chip 上方弹出。先列全部运行中（active）行，再列 waiting 行。
 * waiting 行右侧 × 按钮取消。最多 6 个 item 高度，超出内部滚动。
 */
function QueuePopover({
  active,
  waiting,
  onCancel,
  onJumpToPr,
}: {
  active: ReturnType<typeof useChatRunStore>['active'];
  waiting: ReturnType<typeof useChatRunStore>['waiting'];
  onCancel: (runId: string) => void;
  onJumpToPr: (localId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="statusbar-queue-popover" role="menu" aria-label={t('statusBar.queueAria')}>
      <div className="statusbar-queue-header">
        <span className="muted">{t('statusBar.queueHeader')}</span>
        <span className="muted">
          {t('statusBar.queueSummary', { running: active.length, waiting: waiting.length })}
        </span>
      </div>
      <ul className="statusbar-queue-list">
        {active.map((a) => (
          <li className="statusbar-queue-item statusbar-queue-item-active" key={a.runId}>
            <span className="statusbar-pragent-dot" aria-hidden="true" />
            <button
              type="button"
              className="statusbar-queue-meta"
              onClick={() => onJumpToPr(a.prLocalId)}
              title={t('statusBar.jumpToPr')}
            >
              <span className="statusbar-queue-tool">/{a.tool}</span>
              <code className="statusbar-queue-pr">{a.prLocalId}</code>
            </button>
            <span className="muted statusbar-queue-state">{t('statusBar.running')}</span>
          </li>
        ))}
        {waiting.map((q) => (
          <li className="statusbar-queue-item" key={q.runId}>
            <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
            <button
              type="button"
              className="statusbar-queue-meta"
              onClick={() => onJumpToPr(q.prLocalId)}
              title={t('statusBar.jumpToPr')}
            >
              <span className="statusbar-queue-tool">/{q.tool}</span>
              <code className="statusbar-queue-pr">{q.prLocalId}</code>
            </button>
            <span className="muted statusbar-queue-state">{t('statusBar.queued')}</span>
            <button
              type="button"
              className="statusbar-queue-cancel"
              onClick={() => onCancel(q.runId)}
              title={t('statusBar.removeFromQueue')}
              aria-label={t('common.cancel')}
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
  const { t } = useTranslation();
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
  const text = empty ? t('statusBar.llmNotConfigured') : active.model || active.label || active.provider;
  const title = empty
    ? t('statusBar.llmNotConfiguredTitle')
    : `LLM: ${active.label || t('statusBar.unnamed')}\nprovider: ${active.provider}${
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
                    {p.label || t('statusBar.profileFallbackName', { id: p.id.slice(0, 4) })}
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
            <span className="muted">{t('statusBar.manageLlm')}</span>
          </button>
        </div>
      )}
    </span>
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
  const { t } = useTranslation();
  // 每 30s 重渲染一次，让 "刚刚 / N 分钟前" 文案随时间向前推进
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const date = at ? new Date(at) : null;
  const label = refreshing ? t('statusBar.refreshing') : date ? formatRelative(date, t) : '—';
  const title = refreshing
    ? t('statusBar.refreshing')
    : date
      ? t('statusBar.lastSyncTitle', { time: date.toLocaleString() })
      : t('statusBar.neverSyncedTitle');
  return (
    <button
      type="button"
      className={`statusbar-chip statusbar-chip-sync statusbar-sync-btn${
        refreshing ? ' icon-btn-spinning' : ''
      }`}
      onClick={onRefresh}
      disabled={refreshing}
      title={title}
      aria-label={t('statusBar.refreshAria')}
    >
      <SyncIcon />
      {label}
    </button>
  );
}

function formatRelative(date: Date, t: TFunction): string {
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 30) return t('statusBar.justNow');
  if (diffSec < 60) return t('statusBar.secondsAgo', { count: diffSec });
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t('statusBar.minutesAgo', { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t('statusBar.hoursAgo', { count: diffHr });
  // 超过 1 天直接给绝对时间，避免 "3 天前" 这种模糊
  return date.toLocaleString();
}

function PrAgentChip({ status }: { status: PrAgentStatus }) {
  const { t } = useTranslation();
  if (status.available) {
    // chip 只显示 pr-agent 版本，不显示 strategy（embedded/local-cli 对用户无意义；
    // 完整 strategy + version 放 hover title）。version 来自 detect：
    // - embedded → `pr-agent 0.36.0` → 取 `0.36.0`
    // - local-cli → `pr-agent --help` 首行，截到首个空白前（避免长 usage 撑爆 chip）
    const ver =
      status.strategy === 'embedded'
        ? status.version.replace(/^pr-agent\s+/, '')
        : status.version.split(/\s+/)[0] || status.version;
    return (
      <span
        className="statusbar-chip statusbar-chip-ok"
        title={`${status.strategy} · ${status.version}`}
      >
        {t('statusBar.prAgentVersion', { ver })}
      </span>
    );
  }
  return (
    <span
      className="statusbar-chip statusbar-chip-err"
      title={status.attempts.map((a) => a.error).join('\n')}
    >
      {t('statusBar.prAgentUnavailable')}
    </span>
  );
}

function UserChip({ connections }: { connections: ConnectionSummary[] }) {
  const { t } = useTranslation();
  const labels = connections
    .filter((c) => c.user)
    .map((c) =>
      connections.length > 1 ? `${c.displayName}: ${c.user!.displayName}` : c.user!.displayName,
    );
  if (labels.length === 0) return null;
  const title = connections
    .map(
      (c) => `${c.displayName}: ${c.user ? `${c.user.displayName} (${c.user.name})` : t('statusBar.userUnidentified')}`,
    )
    .join('\n');
  return (
    <span className="statusbar-user" title={title}>
      <PersonIcon />
      {labels.join(' · ')}
    </span>
  );
}

