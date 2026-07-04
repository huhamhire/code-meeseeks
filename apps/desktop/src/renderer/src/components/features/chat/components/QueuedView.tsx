import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRunTool } from '@meebox/shared';
import { CloseIcon } from '../../../common';
import { AskQuestion } from './shared';

/**
 * Queued task card: sits after the running one, showing tool / position / (ask's question) in queue order,
 * with per-item cancel. Shares the chat-run-meta skeleton with RunningView / RunMeta for visual consistency.
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
