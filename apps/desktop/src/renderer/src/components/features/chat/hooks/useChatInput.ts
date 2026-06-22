import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PrAgentStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import { COMMANDS, type CommandSpec } from '../commands';
import { loadChatHistory, pushChatHistory } from '../utils/chat-history';
import { parseChatCommand } from '../utils/parse-command';

export interface UseChatInputParams {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  llmConfigured: boolean;
  runningTool: ReviewRunTool | null;
  agentRunningHere: boolean;
  onRun: (tool: ReviewRunTool, question?: string) => void;
  onAgentAsk: (question: string) => void;
  onCancel?: () => void;
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /** 外部预填输入（如点 finding「引用」后填入默认复评问题）；seq 变化即重填一次（即便文本相同）。 */
  prefill?: { text: string; seq: number };
}

/**
 * 输入栏状态机：输入 / `/` 命令解析与提交 / 自动补全浮层 / 历史回放（shell 式 Up/Down）/ 停止请求。
 * 命令解析纯逻辑见 ../utils/parse-command；历史栈见 ../utils/chat-history。ChatInputBar 只消费返回值渲染。
 */
export function useChatInput({
  pr,
  prAgent,
  llmConfigured,
  runningTool,
  agentRunningHere,
  onRun,
  onAgentAsk,
  onCancel,
  onSetReviewStatus,
  prefill,
}: UseChatInputParams) {
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

  // 外部预填（finding「引用」→ 默认复评问题）：seq 变化即填入并聚焦、光标移末尾。
  useEffect(() => {
    if (!prefill) return;
    setInput(prefill.text);
    setParseError(null);
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(prefill.text.length, prefill.text.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.seq]);

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

  const requestStop = (): void => {
    if (stopRequested) return;
    setStopRequested(true);
    onCancel?.();
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

  // 提交成功路径共用：写历史栈 + 退出浏览态 + 清空输入
  const pushHistoryAndReset = (): void => {
    setHistory(pushChatHistory(input));
    setHistoryIdx(-1);
    draftBeforeHistoryRef.current = '';
    setInput('');
  };

  const submit = (): void => {
    if (disabled || !trimmed) return;
    setParseError(null);
    const parsed = parseChatCommand(trimmed);
    switch (parsed.kind) {
      case 'unknown':
        setParseError(
          t('chatPane.unknownCommand', {
            head: parsed.head,
            cmds: COMMANDS.map((c) => c.label).join(' / '),
          }),
        );
        return;
      case 'commandNoArgs':
        setParseError(t('chatPane.commandNoArgs', { cmd: parsed.cmd }));
        return;
      case 'askNeedsQuestion':
        setParseError(t('chatPane.askNeedsQuestion'));
        return;
      case 'reviewAction':
        if (!onSetReviewStatus) return; // 没装回调直接忽略 (保护性)
        pushHistoryAndReset();
        onSetReviewStatus(parsed.status);
        return;
      case 'run':
        pushHistoryAndReset();
        onRun(parsed.name, parsed.question);
        return;
      case 'agentAsk':
        pushHistoryAndReset();
        onAgentAsk(parsed.question);
        return;
    }
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

  return {
    input,
    setInput,
    parseError,
    disabled,
    running,
    stopRequested,
    requestStop,
    showAutocomplete,
    filtered,
    autocompleteIdx,
    setAutocompleteIdx,
    cmdMenuOpen,
    setCmdMenuOpen,
    handleInsertCommand,
    onKeyDown,
    submit,
    placeholder,
    textareaRef,
    cmdMenuRef,
  };
}
