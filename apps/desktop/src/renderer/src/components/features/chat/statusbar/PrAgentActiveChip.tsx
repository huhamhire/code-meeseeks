import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { useChatRunStore } from '../../../../stores/chat-run-store';
import { formatElapsed } from '../../../../utils/time';
import { StatusChip } from '../../../common';

/**
 * Queue popover: pops up above the status bar chip. Lists all active rows first, then waiting rows.
 * The × button on the right of a waiting row cancels it. Max 6 items tall, scrolls internally beyond that.
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
            <span className="activity-dot" aria-hidden="true" />
            <button
              type="button"
              className="statusbar-queue-meta"
              onClick={() => onJumpToPr(a.prLocalId)}
              title={t('statusBar.jumpToPr')}
            >
              <span className="statusbar-queue-tool">/{a.tool}</span>
              <span className="statusbar-queue-pr">
                {a.repoSlug} <span className="statusbar-queue-prnum">#{a.prNumber}</span>
              </span>
            </button>
            <span className="muted statusbar-queue-state">{t('statusBar.running')}</span>
            <button
              type="button"
              className="statusbar-queue-cancel"
              onClick={() => onCancel(a.runId)}
              title={t('statusBar.stopRunning')}
              aria-label={t('common.cancel')}
            >
              ×
            </button>
          </li>
        ))}
        {waiting.map((q) => (
          <li className="statusbar-queue-item" key={q.runId}>
            <span className="activity-dot activity-dot-idle" aria-hidden="true" />
            <button
              type="button"
              className="statusbar-queue-meta"
              onClick={() => onJumpToPr(q.prLocalId)}
              title={t('statusBar.jumpToPr')}
            >
              <span className="statusbar-queue-tool">/{q.tool}</span>
              <span className="statusbar-queue-pr">
                {q.repoSlug} <span className="statusbar-queue-prnum">#{q.prNumber}</span>
              </span>
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
 * pr-agent activity chip: when active, shows the running tool + elapsed (clickable to jump to PR);
 * when idle, shows an "idle" placeholder. Switching PRs won't lose running state, which chatRunStore maintains across instances.
 *
 * Callers should only mount this when pr-agent is actually available (PrAgentStatus.available).
 */
export function PrAgentActiveChip({ onJumpToPr }: { onJumpToPr?: (localId: string) => void }) {
  const { t } = useTranslation();
  const { active, waiting } = useChatRunStore();
  // Concurrency model: active is the list of running runs. The chip body shows the first (primary) run's tool + elapsed,
  // with a badge showing the concurrent total when there's more than one; opening the popover lists all running + queued.
  const primary = active[0] ?? null;
  const runningCount = active.length;
  // Timer: 1s granularity, synced with ChatPane's elapsed. Only started when there's a primary.
  const [elapsedMs, setElapsedMs] = useState(0);
  // startedAt is null while queued, set when executeRun starts; fallback to enqueuedAt is fine
  const startMs = primary ? new Date(primary.startedAt ?? primary.enqueuedAt).getTime() : 0;
  useEffect(() => {
    if (!primary) return;
    setElapsedMs(Date.now() - startMs);
    const id = setInterval(() => setElapsedMs(Date.now() - startMs), 1000);
    return () => clearInterval(id);
    // Only depend on primary runId + startMs: changes to other fields don't affect timing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.runId, startMs]);

  // Queue popover: opening it (active chip + queue ≥1) shows the waiting list + × to cancel
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
  // Nothing to expand (no queue and running ≤1) → auto-collapse the menu
  useEffect(() => {
    if (queueOpen && waiting.length === 0 && active.length <= 1) setQueueOpen(false);
  }, [queueOpen, waiting.length, active.length]);

  const handleCancelQueued = (runId: string): void => {
    void invoke('pragent:cancel', { runId });
  };

  if (!primary) {
    // Idle: static gray dot + "idle" text. Lets the user see at a glance "agent available + nothing running right now"
    return (
      <StatusChip
        className="statusbar-pragent-chip statusbar-pragent-chip-idle"
        title={t('statusBar.prAgentIdleTitle')}
      >
        <span className="activity-dot activity-dot-idle" aria-hidden="true" />
        <span>{t('statusBar.idle')}</span>
      </StatusChip>
    );
  }

  // Expandable (running >1 or has queue) → chip becomes a button that opens the popover; otherwise jumps to PR via onJumpToPr.
  const expandable = waiting.length > 0 || runningCount > 1;
  const clickable = expandable || Boolean(onJumpToPr);
  const handleClick = (): void => {
    if (expandable) {
      setQueueOpen((v) => !v);
    } else {
      onJumpToPr?.(primary.prLocalId);
    }
  };
  // Badge count = other concurrent running (runningCount-1) + queued (waiting)
  const extraCount = runningCount - 1 + waiting.length;
  const title = expandable
    ? t('statusBar.prAgentExpandableTitle', { running: runningCount, waiting: waiting.length })
    : t('statusBar.prAgentRunningTitle', { pr: primary.prLocalId, tool: primary.tool }) +
      (clickable ? t('statusBar.jumpHint') : '');
  const inner = (
    <>
      <span className="activity-dot" aria-hidden="true" />
      <span>/{primary.tool}</span>
      <span className="statusbar-pragent-elapsed">
        {formatElapsed(elapsedMs, { compact: true })}
      </span>
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
      <StatusChip
        className={`statusbar-pragent-chip${queueOpen ? ' active' : ''}`}
        title={title}
        onClick={clickable ? handleClick : undefined}
      >
        {inner}
      </StatusChip>
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
