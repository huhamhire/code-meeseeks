import { useTranslation } from 'react-i18next';
import type { AgentTodoItem } from '@meebox/shared';

/**
 * Plan panel for the planning Agent: shows the current todo (checked = done). Refreshes live from
 * agent:planUpdated while running, reorders with new input; hydrates via agent:getSession on PR switch /
 * restart. Empty plan is not rendered.
 */
export function PlanPanel({ todo }: { todo: AgentTodoItem[] }) {
  const { t } = useTranslation();
  if (todo.length === 0) return null;
  const done = todo.filter((it) => it.done).length;
  return (
    <div className="chat-plan-panel" role="group" aria-label={t('chatPane.planTitle')}>
      <div className="chat-plan-head">
        <span className="chat-plan-title">{t('chatPane.planTitle')}</span>
        <span className="chat-plan-count">
          {done}/{todo.length}
        </span>
      </div>
      <ul className="chat-plan-list">
        {todo.map((it) => (
          <li key={it.id} className={`chat-plan-item${it.done ? ' done' : ''}`}>
            <span className="chat-plan-check" aria-hidden>
              {it.done ? '✓' : '○'}
            </span>
            <span className="chat-plan-text">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
