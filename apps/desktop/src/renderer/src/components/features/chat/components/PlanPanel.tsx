import { useTranslation } from 'react-i18next';
import type { AgentTodoItem } from '@meebox/shared';

/**
 * 规划 Agent 的计划面板：展示当前 todo（勾选 = 已完成）。运行中据 agent:planUpdated 实时刷新、随新输入
 * 重排；切 PR / 重启经 agent:getSession 水合。空计划不渲染。
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
