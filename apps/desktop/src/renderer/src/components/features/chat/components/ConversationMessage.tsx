import { useTranslation } from 'react-i18next';
import type { AgentMessage } from '@meebox/shared';
import { ChatIcon } from '../../../common';
import { VERDICT_LABEL_KEY } from '../constants';
import { Md } from './shared';

/**
 * Display of a single multi-turn conversation message: user → right-aligned bubble; assistant review type
 * (with recommendation) → "review summary" card + verdict badge; assistant conversation type (no
 * recommendation) → left-aligned dedicated conversation reply wrapper.
 */
export function ConversationMessage({ message }: { message: AgentMessage }) {
  const { t } = useTranslation();
  if (message.role === 'user') {
    return (
      <div className="chat-user-row">
        <div className="chat-user-bubble">{message.content}</div>
        {/* Reference context carried by the question (Diff selection code): collapsed display below the bubble, collapsed by default to stay compact.
            referencedContext comes with its own path / line range / code fence, rendered via markdown. */}
        {message.referencedContext && (
          <details className="chat-user-ref markdown">
            <summary>{t('chatPane.referencedContextLabel')}</summary>
            <Md>{message.referencedContext}</Md>
          </details>
        )}
      </div>
    );
  }
  if (message.recommendation) {
    return (
      <div className="chat-agent-summary" role="status">
        <div className="chat-agent-summary-head">
          <strong>{t('chatPane.agent.summaryTitle')}</strong>
          <span
            className={`chat-chip chat-chip-tight chat-chip-md chat-chip-outline chat-agent-verdict verdict-${message.recommendation.verdict}`}
          >
            {t(VERDICT_LABEL_KEY[message.recommendation.verdict])}
          </span>
        </div>
        <div className="markdown chat-agent-summary-text">
          <Md>{message.content}</Md>
        </div>
        {message.recommendation.reason && (
          <div className="markdown muted chat-agent-summary-reason">
            <Md>{message.recommendation.reason}</Md>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="chat-agent-reply" role="status">
      <ChatIcon size={16} />
      <div className="markdown chat-agent-reply-body">
        <Md>{message.content}</Md>
      </div>
    </div>
  );
}
