import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRunTool } from '@meebox/shared';
import { CloseIcon } from '../../../common';
import { AskQuestion } from './shared';

/**
 * 排队中的任务卡片：贴在运行中之后，按队列顺序展示 tool / 位置 / (ask 的提问)，
 * 提供单条取消。跟 RunningView / RunMeta 共用 chat-run-meta 骨架，视觉一致。
 */
export function QueuedView({
  tool,
  question,
  position,
  onCancel,
}: {
  tool: ReviewRunTool;
  question?: string;
  position: number;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const userMessage = tool === 'ask' ? question?.trim() : undefined;
  return (
    <div className="chat-run-queued">
      <header className="chat-run-meta">
        <span className={`chat-run-tool chat-run-tool-${tool}`}>/{tool}</span>
        <span className="chat-chip chat-run-status chat-run-status-queued">
          {t('chatPane.queuedPosition', { position })}
        </span>
        <button
          type="button"
          className="chat-run-queued-cancel"
          onClick={() => {
            if (cancelling) return;
            setCancelling(true);
            onCancel();
          }}
          disabled={cancelling}
          title={t('chatPane.cancelQueuedTitle')}
          aria-label={t('chatPane.cancelQueuedTitle')}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      {userMessage && <AskQuestion text={userMessage} />}
    </div>
  );
}
