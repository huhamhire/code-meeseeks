import { useTranslation } from 'react-i18next';
import type { PrAgentStatus, StoredPullRequest } from '@meebox/shared';
import { ChatIcon } from '../../common/icons';
import { Bullet } from './shared';

export function ChatEmpty({
  pr,
  prAgent,
  llmConfigured,
  onOpenSettings,
}: {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  llmConfigured: boolean;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  if (!prAgent.available) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon" aria-hidden="true">
          <ChatIcon size={28} />
        </div>
        <p className="chat-empty-title">{t('chatPane.emptyNotReadyTitle')}</p>
        <p className="chat-empty-sub">{t('chatPane.emptyNotReadySub')}</p>
      </div>
    );
  }
  // pr-agent 运行时就绪但没有可用 LLM → 引导去设置配置一条模型
  if (!llmConfigured) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon" aria-hidden="true">
          <ChatIcon size={28} />
        </div>
        <p className="chat-empty-title">{t('chatPane.emptyNeedLlmTitle')}</p>
        <p className="chat-empty-sub">{t('chatPane.emptyNeedLlmSub')}</p>
        {onOpenSettings && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={onOpenSettings}
          >
            {t('chatPane.goToSettings')}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden="true">
        <ChatIcon size={28} />
      </div>
      <p className="chat-empty-title">
        {pr ? t('chatPane.emptyReadyTitle') : t('chatPane.emptySelectPrTitle')}
      </p>
      <p className="chat-empty-sub">{t('chatPane.emptyInputHint')}</p>
      <p className="chat-empty-sub">{t('chatPane.emptyCmdHint')}</p>
      <ul className="chat-empty-list">
        <Bullet>
          <code>/describe</code> {t('chatPane.bulletDescribe')}
        </Bullet>
        <Bullet>
          <code>/review</code> {t('chatPane.bulletReview')}
        </Bullet>
        <Bullet>
          <code>/improve</code> {t('chatPane.bulletImprove')}
        </Bullet>
        <Bullet>
          <code>/ask &lt;{t('chatPane.askArgQuestion')}&gt;</code> {t('chatPane.bulletAsk')}
        </Bullet>
      </ul>
      <p className="chat-empty-foot muted">
        {pr ? t('chatPane.emptyFootWithPr') : t('chatPane.emptyFootNoPr')}
      </p>
    </div>
  );
}
