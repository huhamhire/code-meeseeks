import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../api';
import { useChatRunStore } from '../../../../stores/chat-run-store';
import { formatElapsed } from '../../../../utils/time';
import { StatusChip } from '../../../common';

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
            <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
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
 * pr-agent 活动状态 chip：active 时显示运行中工具 + elapsed (可点跳 PR)；idle 时
 * 显示"空闲"占位。PR 切换不会丢运行中状态，由 chatRunStore 跨实例维护。
 *
 * 调用方应在 pr-agent 实际可用 (PrAgentStatus.available) 时才挂这条。
 */
export function PrAgentActiveChip({ onJumpToPr }: { onJumpToPr?: (localId: string) => void }) {
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
      <StatusChip
        className="statusbar-pragent-chip statusbar-pragent-chip-idle"
        title={t('statusBar.prAgentIdleTitle')}
      >
        <span className="statusbar-pragent-dot statusbar-pragent-dot-idle" aria-hidden="true" />
        <span>{t('statusBar.idle')}</span>
      </StatusChip>
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
