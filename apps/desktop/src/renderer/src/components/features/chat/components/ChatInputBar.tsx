import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalPrStatus, PrAgentStatus, ReviewRunTool, StoredPullRequest } from '@meebox/shared';
import { AutoReviewIcon, SendIcon, StopIcon } from '../../../common/icons';
import { COMMANDS, type CommandSpec } from '../commands';
import { loadChatHistory, pushChatHistory } from '../utils/chat-history';

interface ChatInputBarProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  /** LLM 是否已配置；未配置时禁用输入（即便 pr-agent 运行时就绪也无法调用） */
  llmConfigured: boolean;
  /**
   * 本 PR 上的活动 run 工具；非空时在 send 按钮旁额外渲染 stop 按钮。
   * 队列模型下输入永不因此禁用 (新提交进队列)。
   */
  runningTool: ReviewRunTool | null;
  onRun: (tool: ReviewRunTool, question?: string) => void;
  /** 无 '/' 前缀的自然语言输入 → 交给自由规划 Agent（对话即委派，见设计「会话 Agent 化」）。 */
  onAgentAsk: (question: string) => void;
  /**
   * 终止当前活动 run。仅 runningTool 非空时有意义；ChatPane 已绑好对应 runId。
   * stop 按钮跟 send 共用槽位：runningTool 时点击触发此回调而非 onRun
   */
  onCancel?: () => void;
  /** /approve /needswork 命令触发的 review 决断，跟 PR header 按钮共用 prs:setLocalStatus */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /** Agent 是否跑在当前 PR：决定图标按钮高亮 + 运行中文案 + 禁用重复发起（其它 PR 在跑不禁用本 PR）。 */
  agentRunningHere: boolean;
  /** 触发一键自动评审微流程（describe→review→条件追问→总结）。 */
  onAgentReview: () => void;
}

/**
 * 输入栏：textarea + 命令按钮 + `/` 触发的自动补全。
 *
 * 提交语义 (按 Enter 或点发送)：
 * - 空输入 → 不提交
 * - `/describe` / `/review` 开头 → 触发对应工具，忽略后面文字
 * - `/ask <文本>` 开头 → 触发 ask，rest 作 question
 * - `/xxx` 但 xxx 未知 → 报错提示
 * - 不以 `/` 开头 → 等价于 `/ask <整段>`
 *
 * Shift+Enter 换行，Enter 提交。textarea 高度 1→5 行自适应，超过 5 行内部滚动。
 */
export function ChatInputBar({
  pr,
  prAgent,
  llmConfigured,
  runningTool,
  onRun,
  onAgentAsk,
  onCancel,
  onSetReviewStatus,
  agentRunningHere,
  onAgentReview,
}: ChatInputBarProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  // PR 切换时清掉异常提示 + 输入框残留 (避免跨 PR 显示陈旧的错误"未知命令" 等)
  useEffect(() => {
    setParseError(null);
    setInput('');
  }, [pr?.localId]);
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false);
  // 自动补全菜单选中项索引 (textarea 输入 / 时显示的浮层)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  // 已经为某个特定输入值关闭过菜单 (Esc / 选中后插入)。input 一变就失效
  // → 用户继续打字时菜单会自然重新出现，但选中 / Esc 后不会立刻重弹
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // 历史回放：从最新到最老的栈；historyIdx 表示当前正在浏览的位置 (-1 = 不在浏览态)
  const [history, setHistory] = useState<string[]>(() => loadChatHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  // 进入历史浏览前用户正在编辑的内容；按 Down 回到底端时还原回去，模仿 shell 行为
  const draftBeforeHistoryRef = useRef<string>('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);

  // 队列模型：仅 !pr / pr-agent 未就绪 时禁用 input。activeRun / busyOnOtherPr
  // 不再阻塞新提交 (会排队 by main)。running 决定是否渲染 stop 按钮：除活动工具 run 外，
  // Agent 自身执行阶段（思考 / 编排，无工具 run 占用）也算「运行中」，以便随时取消。
  const running = runningTool !== null || agentRunningHere;
  // LLM 未配置时一并禁用：即便 pr-agent 运行时就绪，没有模型也无法发起调用
  const disabled = !pr || !prAgent.available || !llmConfigured;
  // stop 按钮点过后等 main 回 queueChanged 才会改变状态；中间这段时间二次点击
  // 应失效，避免反复 spam abort
  const [stopRequested, setStopRequested] = useState(false);
  // running → false 时 (run 结束了) 重置 stopRequested，下次起 run 又能取消
  useEffect(() => {
    if (!running) setStopRequested(false);
  }, [running]);
  const trimmed = input.trim();
  // `/` 开头 + 命令名还没敲完整 (没空格) → 显示候选；已为当前 input dismiss 过则隐藏
  const showAutocomplete =
    !disabled && dismissedFor !== input && input.startsWith('/') && !input.includes(' ');
  const filtered = showAutocomplete
    ? COMMANDS.filter((c) => c.label.startsWith(input.split(' ')[0] ?? ''))
    : [];

  // 输入变化时重置选中项到首条 (候选集变了)
  useEffect(() => {
    setAutocompleteIdx(0);
  }, [input]);

  // `/` 命令按钮触发的弹出菜单：点击外部 / Esc / 选中命令时关闭
  useEffect(() => {
    if (!cmdMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!cmdMenuRef.current?.contains(e.target as Node)) {
        setCmdMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCmdMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [cmdMenuOpen]);

  // textarea 高度：用户拖顶边 handle 调整。
  //
  // 不用 CSS `resize: vertical` 因为它的 handle 在右下角、向下拖才放大 ——
  // 但 input 整体被钉在 chat 面板底部，视觉上 textarea 是"向上扩展"，跟操作方向
  // 反直觉。改成顶边自绘 handle (类似 chat-pane-resize-handle 模式)，向上拖 = 放大，
  // 视觉操作直觉一致。
  //
  // 边界跟 css 里 min-height (2 行) / max-height (5 行) 一致；state null 时不写
  // inline style，由 css 默认值起手
  const [textareaHeightPx, setTextareaHeightPx] = useState<number | null>(null);
  const handleTextareaResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    const el = textareaRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startHeight = el.getBoundingClientRect().height;
    // 跟 css token: $fs-md=13 * $lh-normal=1.4 = 18.2 px/line；$space-3=6 px padding 上下 = 12 px
    const MIN = Math.round(13 * 1.4 * 2 + 12);
    const MAX = Math.round(13 * 1.4 * 5 + 12);
    const onMove = (ev: MouseEvent): void => {
      // 上拖 dy < 0 → 高度增加；下拖反之
      const dy = ev.clientY - startY;
      const next = Math.min(MAX, Math.max(MIN, startHeight - dy));
      setTextareaHeightPx(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const handleInsertCommand = (cmd: CommandSpec): void => {
    setInput(cmd.insertAs);
    setParseError(null);
    setCmdMenuOpen(false);
    // 选中后立即关掉补全菜单 (insertAs 可能 "/describe" 没空格，否则会一直撑着)。
    // dismissedFor 绑当前 input 值，用户继续打字 input 变了菜单会重新打开
    setDismissedFor(cmd.insertAs);
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(cmd.insertAs.length, cmd.insertAs.length);
      });
    }
  };

  const submit = (): void => {
    if (disabled || !trimmed) return;
    setParseError(null);
    // 解析命令头：'/' 起手 → COMMANDS 表里找；无 '/' → 等价 /ask <整段>
    let cmd: CommandSpec;
    let rest = '';
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      const head = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
      rest = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();
      const found = COMMANDS.find((c) => c.label === head);
      if (!found) {
        setParseError(
          t('chatPane.unknownCommand', {
            head,
            cmds: COMMANDS.map((c) => c.label).join(' / '),
          }),
        );
        return;
      }
      cmd = found;
    } else {
      // 无 '/' → 自然语言「对话即委派」：交给自由规划 Agent（而非 /ask）。
      setHistory(pushChatHistory(input));
      setHistoryIdx(-1);
      draftBeforeHistoryRef.current = '';
      setInput('');
      onAgentAsk(trimmed);
      return;
    }
    // review-action：/approve /needswork 没有参数，多余文本拒绝以免误用
    if (cmd.kind === 'review-action') {
      if (rest) {
        setParseError(t('chatPane.commandNoArgs', { cmd: cmd.label }));
        return;
      }
      if (!onSetReviewStatus) return; // 没装回调直接忽略 (保护性)
      setHistory(pushChatHistory(input));
      setHistoryIdx(-1);
      draftBeforeHistoryRef.current = '';
      setInput('');
      onSetReviewStatus(cmd.reviewStatus);
      return;
    }
    // pragent：/ask 必须带问题，其他工具空 question
    let question: string | undefined;
    if (cmd.name === 'ask') {
      if (!rest) {
        setParseError(t('chatPane.askNeedsQuestion'));
        return;
      }
      question = rest;
    }
    setHistory(pushChatHistory(input));
    setHistoryIdx(-1);
    draftBeforeHistoryRef.current = '';
    setInput('');
    onRun(cmd.name, question);
  };

  // 历史回放工具：根据 idx 设 textarea 内容；idx = -1 表示退出浏览态，恢复 draft
  const applyHistoryIdx = (nextIdx: number): void => {
    setHistoryIdx(nextIdx);
    setInput(nextIdx < 0 ? draftBeforeHistoryRef.current : (history[nextIdx] ?? ''));
    // 光标移到末尾，下一次 Up/Down 行为可预期
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    }
  };

  // 判断是否应让 Up/Down 触发历史回放：textarea 光标必须在首行 / 末行边缘，
  // 否则让 Up/Down 走原生光标移动 (多行编辑时还在行内导航不能被劫持)
  const atFirstLine = (): boolean => {
    const el = textareaRef.current;
    if (!el) return false;
    return el.value.slice(0, el.selectionStart).indexOf('\n') < 0;
  };
  const atLastLine = (): boolean => {
    const el = textareaRef.current;
    if (!el) return false;
    return el.value.slice(el.selectionEnd).indexOf('\n') < 0;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法 composing 中：所有快捷键都不拦截，交给 IME 处理
    if (e.nativeEvent.isComposing) return;

    // 自动补全菜单打开时：拦截 Up/Down/Enter/Tab/Esc 用于菜单导航，避免落到 textarea
    if (showAutocomplete && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAutocompleteIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAutocompleteIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filtered[Math.min(autocompleteIdx, filtered.length - 1)];
        if (cmd) handleInsertCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedFor(input);
        return;
      }
    }

    // 历史回放：菜单未打开时，Up/Down 在边缘行 → 翻历史。中间行让原生光标移动接管
    if (e.key === 'ArrowUp' && history.length > 0 && atFirstLine()) {
      e.preventDefault();
      if (historyIdx < 0) {
        // 首次进浏览态：把当前编辑内容存为 draft，方便 Down 回到底端时复原
        draftBeforeHistoryRef.current = input;
      }
      applyHistoryIdx(Math.min(historyIdx + 1, history.length - 1));
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0 && atLastLine()) {
      e.preventDefault();
      applyHistoryIdx(historyIdx - 1);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = !prAgent.available
    ? t('chatPane.placeholderNotReady')
    : !llmConfigured
      ? t('chatPane.placeholderNeedLlm')
      : !pr
        ? t('chatPane.placeholderNoPr')
        : t('chatPane.placeholderReady');

  return (
    <form
      className="chat-pane-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {showAutocomplete && filtered.length > 0 && (
        <ul className="chat-cmd-suggest" role="listbox" aria-label={t('chatPane.cmdSuggestAria')}>
          {filtered.map((c, i) => {
            const active = i === Math.min(autocompleteIdx, filtered.length - 1);
            const prev = filtered[i - 1];
            const needDivider = prev !== undefined && prev.kind !== c.kind;
            return (
              <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
                <button
                  type="button"
                  className={`chat-cmd-suggest-item${active ? ' active' : ''}`}
                  onClick={() => handleInsertCommand(c)}
                  onMouseEnter={() => setAutocompleteIdx(i)}
                  onMouseDown={(e) => {
                    // 防止 textarea 失焦后 blur 处理把菜单收掉
                    e.preventDefault();
                  }}
                  role="option"
                  aria-selected={active}
                >
                  <code>{c.label}</code>
                  <span className="muted">{t(c.descKey)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="chat-pane-textarea-wrap">
        {/* 顶边拖动 handle：向上拖 → textarea 高度增加，跟视觉扩展方向一致 */}
        <div
          className="chat-pane-textarea-resize-handle"
          onMouseDown={handleTextareaResizeStart}
          title={t('chatPane.resizeInputTitle')}
          aria-label={t('chatPane.resizeInputAria')}
        />
        <textarea
          ref={textareaRef}
          className="chat-pane-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          aria-label={t('chatPane.inputAria')}
          style={
            textareaHeightPx !== null ? { height: `${String(textareaHeightPx)}px` } : undefined
          }
        />
      </div>
      {parseError && <div className="chat-input-error">{parseError}</div>}
      <div className="chat-pane-input-row">
        <div className="chat-cmd-group">
          <div className="chat-cmd-bar" ref={cmdMenuRef}>
            <button
              type="button"
              className={`chat-cmd-trigger${cmdMenuOpen ? ' active' : ''}`}
              onClick={() => setCmdMenuOpen((v) => !v)}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={cmdMenuOpen}
              title={t('chatPane.cmdTriggerTitle')}
            >
              /
            </button>
            {cmdMenuOpen && (
              <ul className="chat-cmd-menu" role="menu">
                {COMMANDS.map((c, i) => {
                  const prev = COMMANDS[i - 1];
                  // pragent → review-action 边界插一道分隔线
                  const needDivider = prev !== undefined && prev.kind !== c.kind;
                  return (
                    <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
                      <button
                        type="button"
                        className="chat-cmd-suggest-item"
                        onClick={() => handleInsertCommand(c)}
                        role="menuitem"
                      >
                        <code>{c.label}</code>
                        <span className="muted">{t(c.descKey)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {/* 自动评审：图标按钮紧贴 `/` 命令触发器右侧。仅 pr-agent 就绪时出现，LLM 未配置 / 本 PR 评审
            进行中则禁用触发（其它 PR 在跑不禁用——可并发 / 排队）。停止统一由发送区的停止按钮负责（取消
            进行中的子任务即终止流程），不再单独提供 Agent 停止按钮，避免两个语义重叠的停止入口。 */}
          {pr && prAgent.available && (
            <button
              type="button"
              className={`chat-cmd-trigger chat-agent-review-trigger${agentRunningHere ? ' active' : ''}`}
              onClick={onAgentReview}
              disabled={!llmConfigured || agentRunningHere}
              title={
                agentRunningHere
                  ? t('chatPane.agent.autoReviewRunning')
                  : t('chatPane.agent.autoReview')
              }
              aria-label={t('chatPane.agent.autoReview')}
            >
              <AutoReviewIcon />
            </button>
          )}
        </div>
        {/* 队列模型下 send 永远在 (新提交进队列)；本 PR active 时 stop 紧贴 send 左侧。
            包到一个 group 里避免 input-row 的 space-between 把 stop 推到中央 */}
        <div className="chat-pane-send-group">
          {running && onCancel && (
            <button
              type="button"
              className="chat-pane-send chat-pane-send-stop"
              onClick={() => {
                if (stopRequested) return;
                setStopRequested(true);
                onCancel();
              }}
              disabled={stopRequested}
              title={t('chatPane.stopTitle')}
              aria-label={t('chatPane.stopAria')}
            >
              <StopIcon />
            </button>
          )}
          <button
            type="submit"
            className="chat-pane-send"
            disabled={disabled || !trimmed}
            title={running ? t('chatPane.sendQueuedTitle') : t('chatPane.sendTitle')}
            aria-label={t('chatPane.sendAria')}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </form>
  );
}
