import { type FormEvent, type ReactNode } from 'react';
import type { StoredPullRequest } from '@pr-pilot/shared';

export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;

interface ChatPaneProps {
  pr: StoredPullRequest | null;
  width: number;
  onResize: (next: number) => void;
}

/**
 * M3 pr-agent 接入前的右侧 chat 面板占位。结构 / 样式按最终要的形态搭好：
 * 标题栏 + 滚动消息区（空态文案）+ 底部输入区（disabled）。M3 时把空态换成
 * 消息列表 + 启用输入框即可。
 */
export function ChatPane({ pr, width, onResize }: ChatPaneProps) {
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    // 拖右边 = 缩小 chat (远离左侧的 dx 是正)
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const next = Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, startWidth - dx));
      onResize(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
  };

  return (
    <aside className="chat-pane" style={{ width: `${String(width)}px` }} aria-label="pr-agent chat">
      <div
        className="chat-pane-resize-handle"
        onMouseDown={startResize}
        title="拖动调整 chat 宽度"
        aria-label="resize chat"
      />
      <header className="chat-pane-header">
        <ChatIcon />
        <span className="chat-pane-title">pr-agent</span>
        {pr && (
          <span className="chat-pane-subtitle" title={pr.title}>
            #{pr.remoteId}
          </span>
        )}
        <span className="chat-pane-stage-tag" title="M3 阶段启用">
          M3
        </span>
      </header>
      <div className="chat-pane-body">
        <ChatEmpty pr={pr} />
      </div>
      <form className="chat-pane-input" onSubmit={handleSubmit}>
        <textarea
          className="chat-pane-textarea"
          placeholder="M3 接入 pr-agent 后启用…"
          disabled
          rows={2}
          aria-label="chat input"
        />
        <div className="chat-pane-input-row">
          <span className="chat-pane-hint muted">/describe · /review · /ask</span>
          <button type="submit" className="btn btn-sm btn-primary" disabled>
            发送
          </button>
        </div>
      </form>
    </aside>
  );
}

function ChatEmpty({ pr }: { pr: StoredPullRequest | null }) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden="true">
        <ChatIcon large />
      </div>
      <p className="chat-empty-title">pr-agent 暂未接入</p>
      <p className="chat-empty-sub">M3 阶段会在这里启用：</p>
      <ul className="chat-empty-list">
        <Bullet>
          <code>/describe</code> 自动生成 PR 摘要 / labels
        </Bullet>
        <Bullet>
          <code>/review</code> 跑一次 AI review，结果落到 findings 列表
        </Bullet>
        <Bullet>自然语言追问当前文件 / 行的代码细节</Bullet>
        <Bullet>选中的 finding 可一键改为评论草稿</Bullet>
      </ul>
      <p className="chat-empty-foot muted">
        {pr ? (
          <>
            当前 PR <code>#{pr.remoteId}</code> 的诊断 / 评审会在 M3 接入后出现在此处
          </>
        ) : (
          '选中一个 PR 后这里会带上它的 #id 作为上下文'
        )}
      </p>
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="chat-empty-bullet" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function ChatIcon({ large }: { large?: boolean } = {}) {
  const size = large ? 28 : 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11A1 1 0 0 1 14.5 4.5v6A1 1 0 0 1 13.5 11.5H6L3 13.5V11.5H2.5A1 1 0 0 1 1.5 10.5v-6A1 1 0 0 1 2.5 3.5z" />
    </svg>
  );
}
