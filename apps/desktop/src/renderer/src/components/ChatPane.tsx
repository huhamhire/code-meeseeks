import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type {
  Finding,
  IpcChannels,
  PrAgentStatus,
  PrDocSectionKey,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from '@pr-pilot/shared';

type MatchedRule = IpcChannels['rules:matchForPr']['response'];
import { invoke, subscribe } from '../api';
import { parseAnsi, segmentStyle } from '../utils/ansi';
import { translatePrAgentLabels } from '../utils/translate-pr-agent';

export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;

interface ChatPaneProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  width: number;
  onResize: (next: number) => void;
  /** 折叠时仍然挂载组件 (保住进行中的 run 计时器 / runProgress 订阅)，
      只用 CSS 隐藏。展开后用户看到的就是当前实时状态 */
  collapsed?: boolean;
}

/**
 * pr-agent 调用面板（M3-D1）。
 * - 头部：两个动作按钮 (/describe /review)，pr-agent 不可用时禁用并指引到 Settings
 * - 运行中：实时滚动 stdout（main 通过 pragent:runProgress 流式推送）
 * - 运行后：展示最新 ReviewRun 的 findings 列表（markdown body + 可选 anchor），
 *   并保留 raw stdout 在底部可折叠区，方便诊断
 *
 * /ask 自然语言追问留到后续：当前 pr-agent 在多轮交互上没有稳定的本地协议，
 * 先把"开始 review → 结果可见"链路打通，覆盖 M3 done-when。
 */
export function ChatPane({ pr, prAgent, width, onResize, collapsed }: ChatPaneProps) {
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

  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [runningTool, setRunningTool] = useState<ReviewRunTool | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 当前 PR 命中的规则 (针对 /review 工具；缺省 tools=[review] 是规则最常生效的场景)
  const [matchedRule, setMatchedRule] = useState<MatchedRule>(null);
  const [showRulePreview, setShowRulePreview] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // PR 切换：重置面板状态 + 拉该 PR 的 run 历史。
  // 依赖用 pr?.localId 而不是 pr 对象引用：App 在 poll tick / window focus 时会
  // reloadPrs → 新 prs 数组 → selected 是新对象引用 → 如果依赖 pr，此 effect 重跑，
  // run 进行中的计时器 / 订阅状态被清空。localId 是稳定字符串，同 PR 刷新不触发。
  const prLocalId = pr?.localId;
  useEffect(() => {
    setRuns([]);
    setRunningTool(null);
    setRunStartedAt(null);
    setLiveLines([]);
    setError(null);
    setMatchedRule(null);
    if (!prLocalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [list, rule] = await Promise.all([
          invoke('pragent:listRuns', { localId: prLocalId }),
          // 默认按 /review 算命中：rules.tools 缺省就是 [review]；/describe 通常没规则
          invoke('rules:matchForPr', { localId: prLocalId, tool: 'review' }),
        ]);
        if (cancelled) return;
        setRuns(list);
        setMatchedRule(rule);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prLocalId]);

  // pragent stdout 流：main 进程广播给所有 window。我们没法在 run 启动前拿到 runId
  // (那是 main 内部分配的)，但同时只允许一个 in-flight，所以"runningTool != null"
  // 时把全部事件都接进 liveLines 即可。PR 切换会清空 runningTool，自然断流
  useEffect(() => {
    if (!runningTool) return;
    return subscribe('pragent:runProgress', (ev) => {
      setLiveLines((prev) => [...prev, ev.line]);
    });
  }, [runningTool]);

  // 触发 /describe / /review / /ask。失败抛回 banner；成功后把新 run 追加到列表
  const handleRun = async (tool: ReviewRunTool, question?: string): Promise<void> => {
    if (!pr || runningTool || !prAgent.available) return;
    setRunningTool(tool);
    setRunStartedAt(Date.now());
    setLiveLines([]);
    setError(null);
    try {
      const finished = await invoke('pragent:run', {
        localId: pr.localId,
        tool,
        question,
      });
      // 追加到 runs 末尾，保留所有历史；列表用 startedAt 升序展示，最新 run 自然在底部
      setRuns((prev) => [...prev.filter((r) => r.id !== finished.id), finished]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningTool(null);
      setRunStartedAt(null);
    }
  };

  // 按 startedAt 升序：聊天界面约定旧消息在上、新消息在下。listReviewRunsForPr 返回的
  // 顺序不保证，我们这里统一一次排序
  const chronoRuns = useMemo(
    () => runs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [runs],
  );

  // 新 run 完成 / runningTool 切换时自动滚到底，让最新消息浮上来
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chronoRuns.length, runningTool]);

  return (
    <aside
      className={`chat-pane${collapsed ? ' chat-pane-collapsed' : ''}`}
      style={{ width: `${String(width)}px` }}
      aria-label="pr-agent chat"
      aria-hidden={collapsed ? true : undefined}
    >
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
        {prAgent.available && (
          <span className="chat-pane-stage-tag" title={`pr-agent ${prAgent.strategy}`}>
            {prAgent.strategy === 'docker' ? 'Docker' : 'CLI'}
          </span>
        )}
      </header>

      {/* 当前 PR 命中的规则 chip：rules.dir 未配置 / 整体禁用 / 无命中 → 不显示。
          点击展开正文预览，让用户能确认本次 review 会被哪条规则约束 */}
      {matchedRule && (
        <button
          type="button"
          className="chat-rule-chip"
          onClick={() => setShowRulePreview(true)}
          title="点击查看规则正文"
        >
          <span className="chat-rule-chip-label">规则</span>
          <span className="chat-rule-chip-id">{matchedRule.id}</span>
        </button>
      )}

      <div className="chat-pane-body" ref={bodyRef}>
        {chronoRuns.length === 0 && !runningTool && <ChatEmpty pr={pr} prAgent={prAgent} />}
        {/* 历史 run 按时间升序堆叠，每条独立卡片 (内部维护自己的 raw stdout 折叠状态)。
            新 run 完成后会自动追加到末尾 + 滚到底 */}
        {chronoRuns.map((r) => (
          <RunResultView key={r.id} run={r} />
        ))}
        {/* 正在跑：进度条 + 实时 stdout 流，贴在历史末尾 */}
        {runningTool && (
          <RunningView
            tool={runningTool}
            lines={liveLines}
            startedAt={runStartedAt ?? Date.now()}
          />
        )}
        {error && (
          <div className="chat-error" role="alert">
            <strong>失败：</strong>
            <span>{error}</span>
          </div>
        )}
      </div>

      <ChatInputBar
        pr={pr}
        prAgent={prAgent}
        runningTool={runningTool}
        onRun={(t, q) => void handleRun(t, q)}
      />

      {showRulePreview && matchedRule && (
        <RulePreviewModal rule={matchedRule} onClose={() => setShowRulePreview(false)} />
      )}
    </aside>
  );
}

/** 槽位定义：键盘操作 / 命令按钮 / 自动补全菜单都从这里取 */
interface CommandSpec {
  name: ReviewRunTool;
  /** 显示在按钮上的标签，含 / 前缀 */
  label: string;
  /** 短提示 */
  desc: string;
  /** 点击命令按钮时在 textarea 中放入的内容；ask 留空格让用户接着写 */
  insertAs: string;
}
const COMMANDS: ReadonlyArray<CommandSpec> = [
  { name: 'describe', label: '/describe', desc: '生成 PR 描述', insertAs: '/describe' },
  { name: 'review', label: '/review', desc: '代码评审', insertAs: '/review' },
  { name: 'ask', label: '/ask', desc: '自然语言追问', insertAs: '/ask ' },
];

interface ChatInputBarProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  runningTool: ReviewRunTool | null;
  onRun: (tool: ReviewRunTool, question?: string) => void;
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
function ChatInputBar({ pr, prAgent, runningTool, onRun }: ChatInputBarProps) {
  const [input, setInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false);
  // 自动补全菜单选中项索引 (textarea 输入 / 时显示的浮层)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  // 已经为某个特定输入值关闭过菜单 (Esc / 选中后插入)。input 一变就失效
  // → 用户继续打字时菜单会自然重新出现，但选中 / Esc 后不会立刻重弹
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);

  const disabled = !pr || runningTool !== null || !prAgent.available;
  const trimmed = input.trim();
  // `/` 开头 + 命令名还没敲完整 (没空格) → 显示候选；已为当前 input dismiss 过则隐藏
  const showAutocomplete =
    !disabled &&
    dismissedFor !== input &&
    input.startsWith('/') &&
    !input.includes(' ');
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

  // textarea 自适应高度：每次 input 变化重新算，capped at 5 行 (跟 css line-height 对齐)
  const adjustHeight = (): void => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 18 * 5 + 16; // 18 = line-height@13px*1.4，16 = padding 上下
    el.style.height = `${String(Math.min(el.scrollHeight, max))}px`;
  };
  useEffect(adjustHeight, [input]);

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
    let tool: ReviewRunTool;
    let question: string | undefined;
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      const head = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();
      const cmd = COMMANDS.find((c) => c.label === head);
      if (!cmd) {
        setParseError(`未知命令 ${head}；支持：${COMMANDS.map((c) => c.label).join(' / ')}`);
        return;
      }
      tool = cmd.name;
      if (tool === 'ask') {
        if (!rest) {
          setParseError('/ask 需要输入问题内容');
          return;
        }
        question = rest;
      }
    } else {
      // 不以 / 起手 → 等价于 /ask <整段>
      tool = 'ask';
      question = trimmed;
    }
    setInput('');
    onRun(tool, question);
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = !prAgent.available
    ? 'pr-agent 未就绪'
    : !pr
      ? '选中一个 PR 后可发起对话'
      : runningTool
        ? `运行 /${runningTool} 中…`
        : '输入问题，或用 / 选择命令';

  return (
    <form
      className="chat-pane-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {showAutocomplete && filtered.length > 0 && (
        <ul className="chat-cmd-suggest" role="listbox" aria-label="命令补全">
          {filtered.map((c, i) => {
            const active = i === Math.min(autocompleteIdx, filtered.length - 1);
            return (
              <li key={c.name}>
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
                  <span className="muted">{c.desc}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <textarea
        ref={textareaRef}
        className="chat-pane-textarea"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="chat input"
      />
      {parseError && <div className="chat-input-error">{parseError}</div>}
      <div className="chat-pane-input-row">
        <div className="chat-cmd-bar" ref={cmdMenuRef}>
          <button
            type="button"
            className={`chat-cmd-trigger${cmdMenuOpen ? ' active' : ''}`}
            onClick={() => setCmdMenuOpen((v) => !v)}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={cmdMenuOpen}
            title="选择预定义命令"
          >
            /
          </button>
          {cmdMenuOpen && (
            <ul className="chat-cmd-menu" role="menu">
              {COMMANDS.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    className="chat-cmd-suggest-item"
                    onClick={() => handleInsertCommand(c)}
                    role="menuitem"
                  >
                    <code>{c.label}</code>
                    <span className="muted">{c.desc}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={disabled || !trimmed}
        >
          发送
        </button>
      </div>
    </form>
  );
}

function RulePreviewModal({
  rule,
  onClose,
}: {
  rule: NonNullable<MatchedRule>;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="规则预览"
      >
        <div className="modal-header">
          <h3>规则: {rule.id}</h3>
          <button className="btn" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-kv">
            <div className="modal-kv-key">文件路径</div>
            <div className="modal-kv-val">{rule.filePath}</div>
            <div className="modal-kv-key">priority</div>
            <div className="modal-kv-val">{rule.priority}</div>
            <div className="modal-kv-key">tools</div>
            <div className="modal-kv-val">{rule.tools.join(', ')}</div>
          </div>
          <div className="markdown" style={{ marginTop: 12 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {rule.instructions}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunningView({
  tool,
  lines,
  startedAt,
}: {
  tool: ReviewRunTool;
  lines: string[];
  startedAt: number;
}) {
  // 末行追加时自动滚到底
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // 计时器：pr-agent stdout 长间隔时让用户感知到不是卡死。1s 粒度即可
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <div className="chat-run-running">
      <div className="chat-run-running-head">
        <Spinner />
        <span>正在执行 /{tool}…</span>
        <span className="chat-run-elapsed">{formatElapsed(elapsedMs)}</span>
        {/* LLM 调用阶段 stdout 没新行，给个软提示让用户知道不是卡死 */}
        {elapsedMs > 15_000 && (
          <span className="chat-run-hint muted">等待 LLM 响应</span>
        )}
      </div>
      <AnsiPre
        className="chat-run-stdout"
        preRef={ref}
        text={lines.join('\n')}
        placeholder="(等待 pr-agent 输出…)"
      />
    </div>
  );
}

/** 把 ms 翻成 "12s" / "1m 23s" 形式；超过分钟阈值后只保留秒粒度 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${String(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}m ${String(s).padStart(2, '0')}s`;
}

/** 把含 ANSI 转义的 stdout 文本渲染成带颜色的 <pre>。空文本时显示占位 */
function AnsiPre({
  className,
  text,
  preRef,
  placeholder,
}: {
  className?: string;
  text: string;
  preRef?: React.Ref<HTMLPreElement>;
  placeholder?: string;
}) {
  if (!text) {
    return (
      <pre className={className} ref={preRef}>
        {placeholder ?? ''}
      </pre>
    );
  }
  const segments = parseAnsi(text);
  return (
    <pre className={className} ref={preRef}>
      {segments.map((seg, i) => (
        <span key={i} style={segmentStyle(seg)}>
          {seg.text}
        </span>
      ))}
    </pre>
  );
}

function RunResultView({ run }: { run: ReviewRun }) {
  const findings = run.findings ?? [];
  const isFailed = run.status === 'failed';
  const stderr = run.stderr ?? '';
  const stdout = run.stdout ?? '';
  // 每条 run 独立维护 raw stdout 折叠态，不再由父组件 lift —— 历史列表里多个 run
  // 互不干扰，用户展开某一条不会影响其他
  const [showRawStdout, setShowRawStdout] = useState(false);
  // /ask 工具：在 run 上方渲染用户发言气泡，让对话上下文可见
  const userMessage = run.tool === 'ask' ? run.question?.trim() : undefined;
  return (
    <div className="chat-run-result">
      {userMessage && (
        <div className="chat-user-msg" aria-label="用户提问">
          <span className="chat-user-msg-label">问</span>
          <div className="chat-user-msg-body">{userMessage}</div>
        </div>
      )}
      <RunMeta run={run} />
      {isFailed && (
        <div className="chat-error" role="alert">
          <strong>
            run 失败{run.errorReason ? ` (${run.errorReason})` : ''}
            {run.exitCode != null && ` · exit ${String(run.exitCode)}`}
          </strong>
          {run.errorMessage && (
            <pre className="chat-error-detail">{run.errorMessage}</pre>
          )}
          {/* 失败时 stderr 是排障的关键，默认展开；非失败时不显示。
              stderr 经常带 ANSI 着色 (尤其 docker / pip / pr-agent 的报错 trace) */}
          {stderr.length > 0 && (
            <details className="chat-error-stderr" open>
              <summary>stderr ({stderr.length} chars)</summary>
              <AnsiPre className="chat-run-stdout" text={stderr} />
            </details>
          )}
          {/* 失败 + stdout 有内容时 (pr-agent 可能写了一半再崩)，也直接展开方便对照 */}
          {stdout.length > 0 && (
            <details className="chat-error-stdout" open>
              <summary>stdout ({stdout.length} chars)</summary>
              <AnsiPre className="chat-run-stdout" text={stdout} />
            </details>
          )}
        </div>
      )}

      {findings.length > 0 ? (
        <ul className="chat-finding-list">
          {orderFindings(findings).map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </ul>
      ) : run.status === 'succeeded' ? (
        <div className="chat-finding-empty muted">
          pr-agent 跑完没有解析出 finding（可能 /describe 仅返回摘要、或解析器跳过了未识别段）。
          可以打开下方 stdout 原文核对。
        </div>
      ) : null}

      {/* 成功 run 也保留 stdout 原文折叠区供"看原文"调试；失败 run 上面已经展开过了，
          这里不重复 */}
      {!isFailed && stdout.length > 0 && (
        <details
          className="chat-run-raw"
          open={showRawStdout}
          onToggle={(e) => {
            if (e.currentTarget.open !== showRawStdout) setShowRawStdout(e.currentTarget.open);
          }}
        >
          <summary>stdout 原文 ({stdout.length} chars)</summary>
          <AnsiPre className="chat-run-stdout" text={stdout} />
        </details>
      )}
    </div>
  );
}

function RunMeta({ run }: { run: ReviewRun }) {
  const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
  return (
    <header className="chat-run-meta">
      <span className={`chat-run-tool chat-run-tool-${run.tool}`}>/{run.tool}</span>
      <span className={`chat-run-status chat-run-status-${run.status}`}>{run.status}</span>
      <span className="muted">{run.strategy === 'docker' ? 'Docker' : 'CLI'}</span>
      <span className="muted">{duration}</span>
    </header>
  );
}

/**
 * sectionKey → 中文标签 + 渲染顺序。把 pr-agent 输出按已知段落排成标准文档骨架：
 *   建议标题 → 类型 → 总结 → 描述 → 走查 → 测试 → 安全 → 代码反馈 → 工作量 → 评分 → 其他
 * 未识别 (sectionKey === undefined 或 'general') 走兜底，按解析顺序放到末尾。
 */
const SECTION_ORDER: Record<PrDocSectionKey, number> = {
  title: 0,
  'pr-type': 1,
  summary: 2,
  description: 3,
  walkthrough: 4,
  'relevant-tests': 5,
  security: 6,
  'code-feedback': 7,
  effort: 8,
  score: 9,
  general: 10,
};
const SECTION_LABEL: Record<PrDocSectionKey, string> = {
  title: '建议标题',
  'pr-type': '类型',
  summary: '总结',
  description: '描述',
  walkthrough: '走查',
  'relevant-tests': '相关测试',
  security: '安全',
  'code-feedback': '代码反馈',
  effort: '工作量',
  score: '评分',
  general: '',
};

/** Stable sort by sectionKey 排序 + 同 key 保留原顺序 (兼容 Array.sort 非 stable JS 引擎) */
function orderFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ka = SECTION_ORDER[a.f.sectionKey ?? 'general'] ?? 99;
      const kb = SECTION_ORDER[b.f.sectionKey ?? 'general'] ?? 99;
      return ka === kb ? a.i - b.i : ka - kb;
    })
    .map((x) => x.f);
}

/**
 * 字符串 → HSL 色相。djb2 简化版，稳定 → 同一标签每次都同色。用于 PR Type 胶囊
 * 自动配色（"Bug fix" / "Enhancement" / "Tests" 各拿不同的色，不需要硬编码字典）。
 */
function labelHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function pillStyle(s: string): React.CSSProperties {
  const hue = labelHue(s);
  // 暗色 UI 上：底色饱和 + 偏暗，文字同色相 + 偏亮，保证对比度
  return {
    backgroundColor: `hsl(${String(hue)}, 55%, 22%)`,
    color: `hsl(${String(hue)}, 85%, 78%)`,
    borderColor: `hsl(${String(hue)}, 50%, 32%)`,
  };
}
/**
 * 把 "Bug fix, Enhancement\nTests" 拆成 ["Bug fix", "Enhancement", "Tests"]。
 * parser 层已经剥过 HR，这里再加一层防御：纯标点 / 长度 ≤1 的项直接 filter 掉，
 * 避免 markdown 装饰符号溜进胶囊（"---" 这种实际遇到过）
 */
function splitTypeLabels(body: string): string[] {
  return body
    .split(/[,\n]/)
    .map((s) => s.replace(/^[\s\-*_·•]+|[\s\-*_·•.]+$/g, '').trim())
    .filter((s) => s.length > 1 && !/^[\s\-*_·•.]+$/.test(s));
}

function FindingCard({ finding }: { finding: Finding }) {
  // sectionKey 优先（新解析的），fallback 到 category (旧持久化的 run)
  const key: PrDocSectionKey = finding.sectionKey ?? 'general';
  const label = SECTION_LABEL[key];
  // 标题在已知 sectionKey 上跟 chip label 内容重复 (h4 显示 "PR Type" + chip 显示
  // "类型")。只有 general / 未知段落 chip 是空的，才需要 h4 给上下文
  const showTitle = !!finding.title && key === 'general';
  // pr-agent 把若干 section 标题 / 固定模板字符串硬编码成英文 (CONFIG__RESPONSE_LANGUAGE
  // 只翻译 LLM 内容值)，渲染前替换成中文
  const translatedBody = translatePrAgentLabels(finding.body);
  const translatedTitle = finding.title ? translatePrAgentLabels(finding.title) : undefined;
  return (
    <li className={`chat-finding chat-finding-${key}`}>
      <header className="chat-finding-head">
        {/* 已知 sectionKey 用中文标签 chip；general / 未知不显示，避免 UI 噪音 */}
        {label && (
          <span className={`chat-finding-cat chat-finding-cat-${key}`}>{label}</span>
        )}
        {showTitle && translatedTitle && (
          <h4 className="chat-finding-title">{translatedTitle}</h4>
        )}
      </header>
      {finding.anchor && (
        <div className="chat-finding-anchor muted">
          <code>{finding.anchor.path}</code>
          {finding.anchor.startLine && (
            <span>
              :{finding.anchor.startLine}
              {finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine
                ? `-${String(finding.anchor.endLine)}`
                : ''}
            </span>
          )}
        </div>
      )}
      {key === 'pr-type' ? (
        // PR Type 段：拆成胶囊，每个标签按内容 hash 取色
        <div className="chat-finding-pills">
          {splitTypeLabels(translatedBody).map((t) => (
            <span key={t} className="pr-type-pill" style={pillStyle(t)}>
              {t}
            </span>
          ))}
        </div>
      ) : (
        <div className="chat-finding-body markdown">
          {/* remarkBreaks 把 finding body 里的单换行也当成 <br>。pr-agent 的 trace、
              或一般段落里 reviewer 习惯按软换行折行，不加 remarkBreaks 会被 markdown
              合并成长一行。Findings 主要是富文本说明，不存在"故意软换行连接"的场景 */}
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {translatedBody}
          </ReactMarkdown>
        </div>
      )}
    </li>
  );
}

function ChatEmpty({ pr, prAgent }: { pr: StoredPullRequest | null; prAgent: PrAgentStatus }) {
  if (!prAgent.available) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon" aria-hidden="true">
          <ChatIcon large />
        </div>
        <p className="chat-empty-title">pr-agent 未就绪</p>
        <p className="chat-empty-sub">
          本机 CLI 与 Docker 都未探测到。打开 Settings 看探测详情，或安装其中一种后重启应用。
        </p>
      </div>
    );
  }
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon" aria-hidden="true">
        <ChatIcon large />
      </div>
      <p className="chat-empty-title">{pr ? '可以开始对话' : '选中一个 PR 后启用'}</p>
      <p className="chat-empty-sub">下方输入框接受命令或自然语言：</p>
      <ul className="chat-empty-list">
        <Bullet>
          <code>/describe</code> 自动生成 PR 摘要 / labels
        </Bullet>
        <Bullet>
          <code>/review</code> 跑一次 AI review，结果落到 findings 列表
        </Bullet>
        <Bullet>
          <code>/ask &lt;问题&gt;</code> 自然语言追问 (或直接打字，自动当 ask)
        </Bullet>
      </ul>
      <p className="chat-empty-foot muted">
        {pr ? '输入框打 / 看命令补全；Shift+Enter 换行' : '未选中 PR：先在左侧列表里挑一条'}
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

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
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
