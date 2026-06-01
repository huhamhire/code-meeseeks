import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type {
  Finding,
  PrAgentStatus,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from '@pr-pilot/shared';
import { invoke, subscribe } from '../api';
import { parseAnsi, segmentStyle } from '../utils/ansi';

export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;

interface ChatPaneProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  width: number;
  onResize: (next: number) => void;
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
export function ChatPane({ pr, prAgent, width, onResize }: ChatPaneProps) {
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
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runningTool, setRunningTool] = useState<ReviewRunTool | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRawStdout, setShowRawStdout] = useState(false);

  // PR 切换：重置面板状态 + 拉该 PR 的 run 历史。run 列表按时间倒序，默认选最新一条
  useEffect(() => {
    setRuns([]);
    setCurrentRunId(null);
    setRunningTool(null);
    setRunStartedAt(null);
    setLiveLines([]);
    setError(null);
    setShowRawStdout(false);
    if (!pr) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke('pragent:listRuns', { localId: pr.localId });
        if (cancelled) return;
        setRuns(list);
        setCurrentRunId(list[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pr]);

  // pragent stdout 流：main 进程广播给所有 window。我们没法在 run 启动前拿到 runId
  // (那是 main 内部分配的)，但同时只允许一个 in-flight，所以"runningTool != null"
  // 时把全部事件都接进 liveLines 即可。PR 切换会清空 runningTool，自然断流
  useEffect(() => {
    if (!runningTool) return;
    return subscribe('pragent:runProgress', (ev) => {
      setLiveLines((prev) => [...prev, ev.line]);
    });
  }, [runningTool]);

  // 触发 /describe 或 /review。失败抛回 banner；成功后把新 run 顶到列表第一条并选中
  const handleRun = async (tool: ReviewRunTool): Promise<void> => {
    if (!pr || runningTool || !prAgent.available) return;
    setRunningTool(tool);
    setRunStartedAt(Date.now());
    setLiveLines([]);
    setError(null);
    try {
      const finished = await invoke('pragent:run', { localId: pr.localId, tool });
      setRuns((prev) => [finished, ...prev.filter((r) => r.id !== finished.id)]);
      setCurrentRunId(finished.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningTool(null);
      setRunStartedAt(null);
    }
  };

  const currentRun = useMemo(
    () => runs.find((r) => r.id === currentRunId) ?? null,
    [runs, currentRunId],
  );

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
        {prAgent.available && (
          <span className="chat-pane-stage-tag" title={`pr-agent ${prAgent.strategy}`}>
            {prAgent.strategy === 'docker' ? 'Docker' : 'CLI'}
          </span>
        )}
      </header>

      <RunActions
        pr={pr}
        prAgent={prAgent}
        runningTool={runningTool}
        onRun={(t) => void handleRun(t)}
      />

      <div className="chat-pane-body">
        {error && (
          <div className="chat-error" role="alert">
            <strong>失败：</strong>
            <span>{error}</span>
          </div>
        )}

        {runningTool ? (
          <RunningView tool={runningTool} lines={liveLines} startedAt={runStartedAt ?? Date.now()} />
        ) : currentRun ? (
          <RunResultView
            run={currentRun}
            showRawStdout={showRawStdout}
            onToggleRawStdout={() => setShowRawStdout((b) => !b)}
          />
        ) : (
          <ChatEmpty pr={pr} prAgent={prAgent} />
        )}
      </div>

      {/* /ask 自然语言追问占位：pr-agent 多轮交互协议未稳定前保持 disabled，
          先把面板尺寸 / 焦点流锁定下来，将来启用时不会让用户感到 UI 跳动 */}
      <AskInputStub />
    </aside>
  );
}

function AskInputStub() {
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
  };
  return (
    <form className="chat-pane-input" onSubmit={onSubmit}>
      <textarea
        className="chat-pane-textarea"
        placeholder="/ask 自然语言追问 (开发中)…"
        disabled
        rows={2}
        aria-label="chat input"
      />
      <div className="chat-pane-input-row">
        <span className="chat-pane-hint muted">/ask 待启用</span>
        <button type="submit" className="btn btn-sm btn-primary" disabled>
          发送
        </button>
      </div>
    </form>
  );
}

interface RunActionsProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  runningTool: ReviewRunTool | null;
  onRun: (tool: ReviewRunTool) => void;
}

function RunActions({ pr, prAgent, runningTool, onRun }: RunActionsProps) {
  const disabled = !pr || runningTool !== null || !prAgent.available;
  const hint = !prAgent.available
    ? '设置 → pr-agent 探测情况'
    : !pr
      ? '从左侧选一个 PR'
      : runningTool
        ? `运行中：/${runningTool}`
        : '触发 pr-agent 工具';
  return (
    <div className="chat-pane-actions" role="toolbar" aria-label="pr-agent 工具">
      <button
        type="button"
        className="btn btn-sm chat-pane-action"
        disabled={disabled}
        onClick={() => onRun('describe')}
        title="生成 PR 摘要 / labels"
      >
        {runningTool === 'describe' ? <Spinner /> : '/describe'}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-primary chat-pane-action"
        disabled={disabled}
        onClick={() => onRun('review')}
        title="跑一次 AI review，得到 findings 列表"
      >
        {runningTool === 'review' ? <Spinner /> : '/review'}
      </button>
      <span className="chat-pane-action-hint muted" title={hint}>
        {hint}
      </span>
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
          <span className="chat-run-hint muted">等待 LLM 响应（常 30-120s）</span>
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

interface RunResultViewProps {
  run: ReviewRun;
  showRawStdout: boolean;
  onToggleRawStdout: () => void;
}

function RunResultView({ run, showRawStdout, onToggleRawStdout }: RunResultViewProps) {
  const findings = run.findings ?? [];
  const isFailed = run.status === 'failed';
  const stderr = run.stderr ?? '';
  const stdout = run.stdout ?? '';
  return (
    <div className="chat-run-result">
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
          {findings.map((f) => (
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
            if (e.currentTarget.open !== showRawStdout) onToggleRawStdout();
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

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <li className={`chat-finding chat-finding-${finding.category}`}>
      <header className="chat-finding-head">
        <span className={`chat-finding-cat chat-finding-cat-${finding.category}`}>
          {finding.category}
        </span>
        {finding.title && <h4 className="chat-finding-title">{finding.title}</h4>}
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
      <div className="chat-finding-body markdown">
        {/* remarkBreaks 把 finding body 里的单换行也当成 <br>。pr-agent 的 trace、
            或一般段落里 reviewer 习惯按软换行折行，不加 remarkBreaks 会被 markdown
            合并成长一行。Findings 主要是富文本说明，不存在"故意软换行连接"的场景 */}
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {finding.body}
        </ReactMarkdown>
      </div>
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
      <p className="chat-empty-title">{pr ? '可以开始 review' : '选中一个 PR 后启用'}</p>
      <p className="chat-empty-sub">上方两个按钮触发 pr-agent：</p>
      <ul className="chat-empty-list">
        <Bullet>
          <code>/describe</code> 自动生成 PR 摘要 / labels
        </Bullet>
        <Bullet>
          <code>/review</code> 跑一次 AI review，结果落到 findings 列表
        </Bullet>
      </ul>
      <p className="chat-empty-foot muted">
        {pr
          ? `当前 PR #${pr.remoteId} 选中；点 /review 开始`
          : '未选中 PR：先在左侧列表里挑一条'}
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
