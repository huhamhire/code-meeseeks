import { useTranslation } from 'react-i18next';
import type { AgentMessage } from '@meebox/shared';
import { ChatIcon } from '../../../common';
import { VERDICT_LABEL_KEY } from '../constants';
import { Md } from './shared';

/**
 * 一条多轮对话消息的展示：用户 → 右对齐气泡；助手评审类（带 recommendation）→「评审总结」卡片 +
 * 判定徽标；助手对话类（无 recommendation）→ 左对齐专属对话回复包装。
 */
export function ConversationMessage({ message }: { message: AgentMessage }) {
  const { t } = useTranslation();
  if (message.role === 'user') {
    return (
      <div className="chat-user-row">
        <div className="chat-user-bubble">{message.content}</div>
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
