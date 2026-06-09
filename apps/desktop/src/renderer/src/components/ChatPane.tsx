import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type {
  Finding,
  IpcChannels,
  LocalPrStatus,
  PrAgentStatus,
  PrDocSectionKey,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';

type MatchedRule = IpcChannels['rules:matchForPr']['response'];
import type { ReviewDraft } from '@meebox/shared';
import { invoke } from '../api';
import {
  ChatIcon,
  CloseIcon,
  QuestionIcon,
  RetryIcon,
  SendIcon,
  StopIcon,
} from './icons';
import { useChatRunStore } from '../stores/chat-run-store';
import { useDraftsForPr } from '../stores/drafts-store';
import { parseAnsi, segmentStyle } from '../utils/ansi';
import { translatePrAgentLabels } from '../utils/translate-pr-agent';

export const CHAT_MIN_WIDTH = 280;
export const CHAT_MAX_WIDTH = 720;
/** 历史 run 的分页大小：进入 PR 默认展示最新 N 条，向上滚动到顶端再追加一批 */
const RUNS_PAGE_SIZE = 10;

interface ChatPaneProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  width: number;
  onResize: (next: number) => void;
  /** 折叠时仍然挂载组件 (保住进行中的 run 计时器 / runProgress 订阅)，
      只用 CSS 隐藏。展开后用户看到的就是当前实时状态 */
  collapsed?: boolean;
  /**
   * 跳到 Diff 视图编辑某条 finding 对应的草稿 (M4)。父组件 (MainPane)
   * 实现：切 tab='diff' + DiffView scroll/highlight/open edit zone + 懒创建 draft
   * 如果还没有。anchor 已由 finding.anchor 直接给到。
   */
  onJumpToDraftEditor?: (target: {
    runId: string;
    findingId: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
  /** /approve /needswork 命令触发的 PR review 决断；由 MainPane 接到 prs:setLocalStatus */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /**
   * 点击 finding 的文件行锚点 → 仅跳转到 Diff 对应行（scroll+highlight，不进编辑态）。
   * 跟 onJumpToDraftEditor 的区别：不带 runId/findingId，不创建 / 打开草稿。
   */
  onNavigateToAnchor?: (anchor: { path: string; startLine: number; endLine: number }) => void;
  /**
   * 当前 active LLM profile 的 model 名 — RunningView meta chip 显示。
   * null = 无 active profile / 还在加载，UI 不展示 model chip
   */
  currentLlmModel?: string | null;
  /**
   * 是否已配置可用的 LLM（存在与 active_id 匹配的 profile）。false 时即便 pr-agent
   * 运行时就绪，也无法发起调用 —— 空态 / 输入栏给出「需配置」提示并禁用。
   */
  llmConfigured?: boolean;
  /** 评审任务并发上限（pr_agent.max_concurrency）。达到后新提交进排队，据此显示提示 */
  maxConcurrency?: number;
  /** 打开设置面板（LLM 未配置提示里的「去设置」按钮用） */
  onOpenSettings?: () => void;
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
export function ChatPane({
  pr,
  prAgent,
  width,
  onResize,
  collapsed,
  onJumpToDraftEditor,
  onSetReviewStatus,
  onNavigateToAnchor,
  currentLlmModel,
  llmConfigured = true,
  maxConcurrency = 2,
  onOpenSettings,
}: ChatPaneProps) {
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

  // runs 按 startedAt 升序保存 (chat 习惯：旧在上 / 新在下)。分页：进入 PR 默认拉
  // 最新 RUNS_PAGE_SIZE 条，向上滚到顶端用 runs[0].id 当游标向 main 要更早一批
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 当前 PR 命中的规则 (针对 /review 工具；缺省 tools=[review] 是规则最常生效的场景)
  const [matchedRule, setMatchedRule] = useState<MatchedRule>(null);
  const [showRulePreview, setShowRulePreview] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 全局活动 run + 实时 stdout 缓存。store 来源于 main 的 'pragent:activeChanged'
  // / 'pragent:runProgress' 事件，PR 切换不丢，所以这里只读，不在本组件维护
  const { active, waiting, linesByRunId } = useChatRunStore();
  // 并发模型：active 是多条并发运行中的 run。本 PR 的运行中 run 可能 >1（用户对同一
  // PR 连发多个工具）；其它 PR 的并发数用于「别处在跑」提示。
  const myActiveRuns = active.filter((a) => a.prLocalId === pr?.localId);
  const hasMyActive = myActiveRuns.length > 0;
  // 仅在「触达并发上限」时提示：此时新提交才会真正排队；未达上限即时并发执行，无需提示。
  const concurrencyReached = active.length >= maxConcurrency;
  // 本 PR 排队中的任务（FIFO，前面的先跑），在 chat 末尾以「排队中」卡片展示
  const myWaiting = waiting.filter((w) => w.prLocalId === pr?.localId);

  // 切走再回来时，正在跑的 run 已落盘 (status=running) → listRuns 把它读进 runs，
  // 同时它又是实时运行中 run，会重复渲染 (历史卡片 + RunningView 各一条)。这里把
  // 所有运行中 run 从历史列表剔除，运行中的展示统一交给下方 RunningView 负责。
  const myActiveIdSet = new Set(myActiveRuns.map((a) => a.runId));
  const visibleRuns = hasMyActive ? runs.filter((r) => !myActiveIdSet.has(r.id)) : runs;

  // PR 切换：重置面板状态 + 拉该 PR 的 run 历史 (含切走前还在跑、现在已落盘的 run)。
  // 依赖用 pr?.localId 而不是 pr 对象引用：App 在 poll tick / window focus 时会
  // reloadPrs → 新 prs 数组 → selected 是新对象引用 → 如果依赖 pr，此 effect 重跑，
  // 用户输入 / 规则提示等组件状态被清空。localId 是稳定字符串，同 PR 刷新不触发。
  const prLocalId = pr?.localId;
  useEffect(() => {
    setRuns([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setError(null);
    setMatchedRule(null);
    if (!prLocalId) return;
    let cancelled = false;
    void (async () => {
      try {
        // listRuns 默认返回 newest-first；这里只拉最新一页 (RUNS_PAGE_SIZE)
        const [list, rule] = await Promise.all([
          invoke('pragent:listRuns', { localId: prLocalId, limit: RUNS_PAGE_SIZE }),
          invoke('rules:matchForPr', { localId: prLocalId, tool: 'review' }),
        ]);
        if (cancelled) return;
        // 反转为升序 (chat 习惯)，UI 直接读 runs 即可
        setRuns([...list].reverse());
        setHasMoreOlder(list.length === RUNS_PAGE_SIZE);
        setMatchedRule(rule);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prLocalId]);

  // 本 PR 的运行中 run 集合发生「移除」→ 那条跑完了：单独 fetch 它 + 按 runId 升序
  // 插入 runs（不重拉整页，避免毁掉用户已向上加载的更早历史）。lines 缓存的回收已
  // 上移到 store 层（setQueue 全局处理），这里不再负责。多并发下逐条 diff 处理。
  const myActiveIds = myActiveRuns.map((a) => a.runId);
  const myActiveIdsKey = myActiveIds.join(',');
  const prevMyActiveRef = useRef<string[]>(myActiveIds);
  const prevPrRef = useRef<string | undefined>(prLocalId);
  useEffect(() => {
    const prevPr = prevPrRef.current;
    prevPrRef.current = prLocalId;
    const prev = prevMyActiveRef.current;
    prevMyActiveRef.current = myActiveIds;
    // PR 切换：prev 属于旧 PR，不能当本 PR 的「跑完」处理，仅同步 ref
    if (prevPr !== prLocalId || !prLocalId) return;
    const current = new Set(myActiveIds);
    for (const runId of prev) {
      if (current.has(runId)) continue;
      void (async () => {
        try {
          const finished = await invoke('pragent:getRun', { localId: prLocalId, runId });
          if (finished) {
            setRuns((prevRuns) => {
              const idx = prevRuns.findIndex((r) => r.id === finished.id);
              if (idx >= 0) {
                // 已在列表（重复事件 / 重连）→ 就地更新
                const next = prevRuns.slice();
                next[idx] = finished;
                return next;
              }
              // 并发完成顺序 ≠ runId 顺序：按 runId 升序插入而非无条件 append，
              // 维持 runs 始终有序（loadOlderRuns 以 runs[0].id 作游标拉更早历史，
              // 依赖此不变量）。runId 字典序即时序，可直接字符串比较。
              const insertAt = prevRuns.findIndex((r) => r.id > finished.id);
              if (insertAt < 0) return [...prevRuns, finished];
              const next = prevRuns.slice();
              next.splice(insertAt, 0, finished);
              return next;
            });
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myActiveIdsKey, prLocalId]);

  // 向上滚到顶端 → 用 runs[0].id 当游标，向 main 要更早一批，prepend 到 runs。
  // 保留视觉滚动位置：插入新内容后把 scrollTop 推到 (newHeight - prevHeight)
  // 抵消，用户看上去像"接着原来位置"
  const loadOlderRuns = async (): Promise<void> => {
    if (loadingOlder || !hasMoreOlder || !prLocalId || runs.length === 0) return;
    setLoadingOlder(true);
    const el = bodyRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const older = await invoke('pragent:listRuns', {
        localId: prLocalId,
        limit: RUNS_PAGE_SIZE,
        beforeId: runs[0]!.id,
      });
      // older 是 newest-first，反转后整段塞到 runs 前面
      setRuns((prev) => [...[...older].reverse(), ...prev]);
      setHasMoreOlder(older.length === RUNS_PAGE_SIZE);
      // 下一帧补齐滚动位置
      requestAnimationFrame(() => {
        if (!bodyRef.current) return;
        bodyRef.current.scrollTop = prevTop + (bodyRef.current.scrollHeight - prevHeight);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  // 触发 /describe / /review / /ask。队列模型下 active 非空也允许提交，新 run 进
  // 队列，main 端先后串行执行。失败抛 banner；成功不需要手动 setRuns，下面 effect
  // 会在 active 切换时自动 refresh
  const handleRun = async (tool: ReviewRunTool, question?: string): Promise<void> => {
    if (!pr || !prAgent.available || !llmConfigured) return;
    setError(null);
    try {
      await invoke('pragent:run', { localId: pr.localId, tool, question });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 取消 / 重试 在 store 模型里就是简单两步：cancel 走 IPC，retry 调 handleRun
  const handleCancel = async (runId: string): Promise<void> => {
    try {
      await invoke('pragent:cancel', { runId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const handleRetry = (run: ReviewRun): void => {
    void handleRun(run.tool, run.question);
  };

  // M4 草稿池：从 main 进程拉本 PR 的草稿，跟 finding 通过 source 字段反查关联
  const drafts = useDraftsForPr(prLocalId);

  /**
   * ChatPane finding card 上点"编辑"按钮的处理：
   * - 已有关联草稿 → 直接 onJumpToDraftEditor，DiffView 打开它
   * - 没有关联草稿 → 懒创建一条 pending + onJumpToDraftEditor
   * - 关联草稿是 rejected → update 回 pending (撤销拒绝) + 跳转
   */
  /**
   * 把 AI finding body 转成草稿初始 body：先 stripFindingMarker 去掉 [file:...]
   * 末尾 marker，再加 `[AI 建议]` 前缀 — 让远端 reviewer 看到时知道这条评论
   * 来自 pr-agent
   */
  const buildDraftBodyFromFinding = (body: string): string =>
    `[AI 建议] ${stripFindingMarker(body)}`;

  const handleJumpToDraft = async (finding: Finding, run: ReviewRun): Promise<void> => {
    if (!pr) return;
    if (
      !finding.anchor ||
      typeof finding.anchor.startLine !== 'number'
    ) {
      return; // 没 anchor 行号 → 没法变 inline，按钮本不该出现，兜底
    }
    const startLine = finding.anchor.startLine;
    const endLine = finding.anchor.endLine ?? startLine;
    const existing = (drafts ?? []).find(
      (d) =>
        d.source !== undefined && d.source.runId === run.id && d.source.findingId === finding.id,
    );
    try {
      if (!existing) {
        // 懒创建：从 finding 拷贝 body 作初始内容；side 默认 'new' (head 侧 inline 评论惯例)
        await invoke('drafts:create', {
          localId: pr.localId,
          draft: {
            anchor: { path: finding.anchor.path, startLine, endLine, side: 'new' },
            body: buildDraftBodyFromFinding(finding.body),
            origin: 'finding',
            source: { runId: run.id, findingId: finding.id },
            status: 'pending',
          },
        });
      } else if (existing.status === 'rejected') {
        // 撤销 reject 决断 → 回到 pending，让用户重新编辑
        await invoke('drafts:update', {
          localId: pr.localId,
          draftId: existing.id,
          patch: { status: 'pending' },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    onJumpToDraftEditor?.({
      runId: run.id,
      findingId: finding.id,
      anchor: { path: finding.anchor.path, startLine, endLine },
    });
  };

  // 点击 finding 锚点：仅导航到 Diff 对应行（不创建/打开草稿），便于快速核对上下文
  const handleNavigateToFinding = (finding: Finding): void => {
    if (!finding.anchor || typeof finding.anchor.startLine !== 'number') return;
    const startLine = finding.anchor.startLine;
    onNavigateToAnchor?.({
      path: finding.anchor.path,
      startLine,
      endLine: finding.anchor.endLine ?? startLine,
    });
  };

  const handleRejectFinding = async (finding: Finding, run: ReviewRun): Promise<void> => {
    if (!pr) return;
    if (!finding.anchor || typeof finding.anchor.startLine !== 'number') return;
    const startLine = finding.anchor.startLine;
    const endLine = finding.anchor.endLine ?? startLine;
    const existing = (drafts ?? []).find(
      (d) =>
        d.source !== undefined && d.source.runId === run.id && d.source.findingId === finding.id,
    );
    try {
      if (existing) {
        await invoke('drafts:update', {
          localId: pr.localId,
          draftId: existing.id,
          patch: { status: 'rejected' },
        });
      } else {
        await invoke('drafts:create', {
          localId: pr.localId,
          draft: {
            anchor: { path: finding.anchor.path, startLine, endLine, side: 'new' },
            body: buildDraftBodyFromFinding(finding.body),
            origin: 'finding',
            source: { runId: run.id, findingId: finding.id },
            status: 'rejected',
          },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 新 run 完成 / 运行中 run 集合变化时自动滚到底，让最新消息浮上来
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, myActiveIdsKey]);

  // 向上滚到顶端 → 触发 loadOlderRuns 拉更早一批 (cursor = runs[0].id)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (el.scrollTop > 8) return;
      void loadOlderRuns();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
    // loadOlderRuns 是稳定的语义包装，依赖项放足够即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreOlder, loadingOlder, prLocalId, runs.length]);

  return (
    <aside
      className={`chat-pane${collapsed ? ' chat-pane-collapsed' : ''}`}
      style={{ width: `${String(width)}px` }}
      aria-label="PR Agent chat"
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
        <span className="chat-pane-title">PR Agent</span>
        {pr && (
          <span className="chat-pane-subtitle" title={pr.title}>
            #{pr.remoteId}
          </span>
        )}
        {/* 运行时策略 chip 撤掉：部署细节用户不关心，状态栏已有 PR Agent 版本 chip */}
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
        {visibleRuns.length === 0 && !hasMyActive && myWaiting.length === 0 && (
          <ChatEmpty
            pr={pr}
            prAgent={prAgent}
            llmConfigured={llmConfigured}
            onOpenSettings={onOpenSettings}
          />
        )}
        {/* 还有更早的 run 未拉到本地 → 顶部出加载提示。继续向上滚自动游标拉一页 */}
        {(hasMoreOlder || loadingOlder) && (
          <div className="chat-run-more-hint muted" role="status">
            {loadingOlder ? '加载中…' : '向上滚动加载更早历史…'}
          </div>
        )}
        {/* 历史 run 按时间升序堆叠，每条独立卡片 (内部维护自己的 raw stdout 折叠状态)。
            初始只拉最新 RUNS_PAGE_SIZE 条；向上滚到顶后再用游标拉更早一批 */}
        {visibleRuns.map((r, i) => (
          <RunResultView
            key={r.id}
            run={r}
            onRetry={handleRetry}
            // 只有"列表里最后一条 + 没有正在跑的"这一种情形下，失败 / 取消的 run 才
            // 可重试；用户已经发起新动作 (无论成功或正在跑) → 旧失败不再展示重试，
            // 避免回头再点重新插队、打乱对话顺序
            canRetry={i === visibleRuns.length - 1 && !hasMyActive}
            drafts={drafts ?? []}
            onJumpToDraft={handleJumpToDraft}
            onRejectFinding={handleRejectFinding}
            onNavigateToFinding={handleNavigateToFinding}
          />
        ))}
        {/* 正在跑（可并发多条）：每条一个进度条 + 实时 stdout 流，贴在历史末尾。
            startedAt 入队时为 null，executeRun 真正起跑时设值；窗口非常短一般看不到
            — fallback 到 enqueuedAt */}
        {prAgent.available &&
          myActiveRuns.map((r) => (
            <RunningView
              key={r.runId}
              tool={r.tool}
              runId={r.runId}
              lines={linesByRunId.get(r.runId) ?? []}
              startedAt={new Date(r.startedAt ?? r.enqueuedAt).getTime()}
              model={currentLlmModel ?? null}
            />
          ))}
        {/* 本 PR 排队中的任务：贴在运行中之后，按队列顺序展示，可单条取消 */}
        {myWaiting.map((w, i) => (
          <QueuedView
            key={w.runId}
            tool={w.tool}
            question={w.question}
            position={i + 1}
            onCancel={() => void handleCancel(w.runId)}
          />
        ))}
        {/* 仅在触达并发上限时提示：此时新提交会排队（未达上限即时并发执行，无需提示）。
            状态栏的队列 chip 可点开查看 / 取消任务 */}
        {concurrencyReached && (
          <div className="chat-busy" role="status">
            已达并发上限（{maxConcurrency} 个同时执行）。本 PR 新提交的任务会进入排队，
            等空出名额后自动执行
          </div>
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
        llmConfigured={llmConfigured}
        // 队列模型下输入永远开启 (新提交进队列 / 并发执行)；runningTool 仅决定是否额外
        // 渲染 stop 按钮 (本 PR 有运行中 run 时可点终止)。多并发时 stop 终止最近一条。
        runningTool={myActiveRuns[myActiveRuns.length - 1]?.tool ?? null}
        onRun={(t, q) => void handleRun(t, q)}
        onCancel={
          hasMyActive
            ? () => void handleCancel(myActiveRuns[myActiveRuns.length - 1]!.runId)
            : undefined
        }
        onSetReviewStatus={onSetReviewStatus}
      />

      {showRulePreview && matchedRule && (
        <RulePreviewModal rule={matchedRule} onClose={() => setShowRulePreview(false)} />
      )}
    </aside>
  );
}

/** 槽位定义：键盘操作 / 命令按钮 / 自动补全菜单都从这里取 */
/**
 * Chat 命令分两类：
 *  - 'pragent': pr-agent 工具 (review / describe / ask)，触发 pragent:run
 *  - 'review-action': PR review 决断 (approve / needswork)，写 Bitbucket reviewer status
 *    通过 prs:setLocalStatus 触发，跟 PR header 按钮共用同一路径
 */
type CommandSpec =
  | {
      kind: 'pragent';
      name: ReviewRunTool;
      label: string;
      desc: string;
      insertAs: string;
    }
  | {
      kind: 'review-action';
      name: 'approve' | 'needswork';
      label: string;
      desc: string;
      insertAs: string;
      reviewStatus: LocalPrStatus;
    };

// 分组顺序：pr-agent 工具 → 分隔线 → review 决断
const COMMANDS: ReadonlyArray<CommandSpec> = [
  // pr-agent
  { kind: 'pragent', name: 'review', label: '/review', desc: '代码评审', insertAs: '/review' },
  { kind: 'pragent', name: 'describe', label: '/describe', desc: '生成 PR 描述', insertAs: '/describe' },
  // /improve 暂屏蔽：实测 pr-agent 的 improve 工具依赖在线平台 (GitHub / GitLab /
  // Bitbucket Cloud) 的 inline code suggestion / best practices 集成，跟 meebox
  // 本地 PR 管理路径不兼容。后端类型 / parser / IPC 仍保留，等策略变化或上游
  // 支持 local provider 时直接放开
  // { kind: 'pragent', name: 'improve', label: '/improve', desc: '逐行代码改进建议', insertAs: '/improve' },
  { kind: 'pragent', name: 'ask', label: '/ask', desc: '自然语言追问', insertAs: '/ask ' },
  // review 决断 (跟 PR header 按钮共用 prs:setLocalStatus，写 Bitbucket reviewer status)
  {
    kind: 'review-action',
    name: 'approve',
    label: '/approve',
    desc: '标记 PR 为通过',
    insertAs: '/approve',
    reviewStatus: 'approved',
  },
  {
    kind: 'review-action',
    name: 'needswork',
    label: '/needswork',
    desc: '标记 PR 为需修改',
    insertAs: '/needswork',
    reviewStatus: 'needs_work',
  },
];

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
  /**
   * 终止当前活动 run。仅 runningTool 非空时有意义；ChatPane 已绑好对应 runId。
   * stop 按钮跟 send 共用槽位：runningTool 时点击触发此回调而非 onRun
   */
  onCancel?: () => void;
  /** /approve /needswork 命令触发的 review 决断，跟 PR header 按钮共用 prs:setLocalStatus */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
}

// 输入历史：最近 5 次成功提交，localStorage 持久化。Up/Down 按键在 textarea 末尾
// 输入位置时回放。命中 / dismissed 后焦点保持在 textarea 上
const CHAT_HISTORY_KEY = 'meebox.chatHistory';
const CHAT_HISTORY_MAX = 5;

/**
 * pr-agent /review 输出的 issue body 尾部含 `[file: <path>, lines: <s>-<e>]`
 * marker — 是我们注入的 prompt directive 让 parser 抽 anchor 的，对用户无意义。
 * FindingCard 渲染前 / 转 draft 时统一清洗
 */
function stripFindingMarker(body: string): string {
  return body.replace(/\s*\[\s*file\s*:\s*[^\]]*?\]\s*$/i, '').trimEnd();
}

function loadChatHistory(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 防御性筛掉非 string 项，并截到上限 (历史 schema 改过也不爆)
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, CHAT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function pushChatHistory(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return loadChatHistory();
  const prev = loadChatHistory();
  // 去重：跟最近一条一样不重复入栈 (用户连续打同样命令很常见)。也清掉历史里
  // 重复的旧条目，让最新的那条上移到顶
  const deduped = prev.filter((v) => v !== trimmed);
  const next = [trimmed, ...deduped].slice(0, CHAT_HISTORY_MAX);
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode → 内存里历史能继续工作就行 */
  }
  return next;
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
function ChatInputBar({
  pr,
  prAgent,
  llmConfigured,
  runningTool,
  onRun,
  onCancel,
  onSetReviewStatus,
}: ChatInputBarProps) {
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
  // 不再阻塞新提交 (会排队 by main)
  const running = runningTool !== null;
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
        setParseError(`未知命令 ${head}；支持：${COMMANDS.map((c) => c.label).join(' / ')}`);
        return;
      }
      cmd = found;
    } else {
      // COMMANDS 里固定有 /ask，find 不会为 undefined — 用 ! 让 TS 收窄即可
      cmd = COMMANDS.find((c) => c.kind === 'pragent' && c.name === 'ask')!;
      rest = trimmed;
    }
    // review-action：/approve /needswork 没有参数，多余文本拒绝以免误用
    if (cmd.kind === 'review-action') {
      if (rest) {
        setParseError(`${cmd.label} 不接受参数`);
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
        setParseError('/ask 需要输入问题内容');
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
    ? 'PR Agent 未就绪'
    : !llmConfigured
      ? '需先配置 LLM 模型才能启用'
      : !pr
        ? '选中一个 PR 后可发起对话'
        : '输入问题，或用 / 选择命令 (↑↓ 翻历史)';

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
                  <span className="muted">{c.desc}</span>
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
          title="拖动调整输入框高度 (2-5 行)"
          aria-label="resize chat input"
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
          aria-label="chat input"
          style={textareaHeightPx !== null ? { height: `${String(textareaHeightPx)}px` } : undefined}
        />
      </div>
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
                      <span className="muted">{c.desc}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
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
              title="终止当前 PR Agent 调用 (SIGKILL)"
              aria-label="停止"
            >
              <StopIcon />
            </button>
          )}
          <button
            type="submit"
            className="chat-pane-send"
            disabled={disabled || !trimmed}
            title={running ? '发送 (新任务会进队列)' : '发送 (Enter)'}
            aria-label="发送"
          >
            <SendIcon />
          </button>
        </div>
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

/**
 * 从 stdout 已收到的行里推断 pr-agent 当前在哪个阶段。pr-agent 在 LLM 调用前会
 * 打几条 INFO 标志位 ("Reviewing PR..." / "Tokens: ... returning full diff"
 * / ...)，LLM 调用本身是几分钟静默；从最近行命中已知模式来给用户更准的状态提示。
 *
 * 大仓库 /review 总时长可能 5min+，没有这个推断只看到 spinner + elapsed 容易
 * 误以为卡住。
 */
function inferPhase(lines: ReadonlyArray<string>): string {
  // 从后往前找最近的命中标志，越靠后的标志代表更"晚"的阶段
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/returning full diff|tokens?\s*[:：]\s*\d+/i.test(line)) return '等待 LLM 响应…';
    if (/answering a pr question|reviewing pr|generating a pr description/i.test(line))
      return '组装 prompt…';
    if (/pr main language/i.test(line)) return '解析 diff…';
    if (/response language/i.test(line)) return '初始化配置…';
  }
  return '启动 PR Agent…';
}

function RunningView({
  tool,
  runId,
  lines,
  startedAt,
  model,
}: {
  tool: ReviewRunTool;
  runId: string;
  lines: ReadonlyArray<string>;
  startedAt: number;
  /** 当前 active LLM profile.model — 跟 RunMeta 同源放在 chip 行，让 running
      跟 succeeded 视觉一致；可选 (无 active profile 时不显示) */
  model: string | null;
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

  const phase = useMemo(() => inferPhase(lines), [lines]);

  // 跟 RunMeta 完全同结构的 chip 行。running 跟 succeeded/failed 共享一套视觉
  // 骨架，用户从列表扫一眼能在固定位置看到 tool / 状态 / 模型 / 时长。strategy
  // 运行时策略是部署细节用户不关心，撤掉；model 是真正影响 review 质量的变量
  return (
    <div className="chat-run-running" data-run-id={runId}>
      <header className="chat-run-meta">
        <span className={`chat-run-tool chat-run-tool-${tool}`}>/{tool}</span>
        <span className="chat-run-status chat-run-status-running">
          <Spinner />
          {RUN_STATUS_LABEL.running}
        </span>
        {model && (
          <span className="chat-run-chip chat-run-model" title={`使用模型 ${model}`}>
            {model}
          </span>
        )}
        <span className="chat-run-chip chat-run-duration">{formatElapsed(elapsedMs)}</span>
        {/* 开始时间：跟 RunMeta 同模 — 纯文本右对齐，让 running 跟 succeeded
            两态最右侧元素位置稳定 */}
        <span
          className="chat-run-time"
          title={`开始于 ${new Date(startedAt).toLocaleString()}`}
        >
          {formatStartTime(startedAt)}
        </span>
      </header>
      {phase && <div className="chat-run-phase">{phase}</div>}
      <AnsiPre
        className="chat-run-stdout"
        preRef={ref}
        text={lines.join('\n')}
        placeholder="(等待 PR Agent 输出…)"
      />
    </div>
  );
}

/**
 * 排队中的任务卡片：贴在运行中之后，按队列顺序展示 tool / 位置 / (ask 的提问)，
 * 提供单条取消。跟 RunningView / RunMeta 共用 chat-run-meta 骨架，视觉一致。
 */
function QueuedView({
  tool,
  question,
  position,
  onCancel,
}: {
  tool: ReviewRunTool;
  question?: string;
  position: number;
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const userMessage = tool === 'ask' ? question?.trim() : undefined;
  return (
    <div className="chat-run-queued">
      <header className="chat-run-meta">
        <span className={`chat-run-tool chat-run-tool-${tool}`}>/{tool}</span>
        <span className="chat-run-status chat-run-status-queued">排队中 · 第 {position} 位</span>
        <button
          type="button"
          className="chat-run-queued-cancel"
          onClick={() => {
            if (cancelling) return;
            setCancelling(true);
            onCancel();
          }}
          disabled={cancelling}
          title="取消排队任务"
          aria-label="取消排队任务"
        >
          <CloseIcon size={14} />
        </button>
      </header>
      {userMessage && (
        <div className="chat-user-msg" aria-label="用户提问">
          <QuestionIcon />
          <div className="chat-user-msg-body">{userMessage}</div>
        </div>
      )}
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

function RunResultView({
  run,
  onRetry,
  canRetry,
  drafts,
  onJumpToDraft,
  onRejectFinding,
  onNavigateToFinding,
}: {
  run: ReviewRun;
  onRetry: (run: ReviewRun) => void;
  /** 由父组件按"最后一条 + 无活动 run"判定；false 时失败 / 取消 run 也不显示重试键 */
  canRetry: boolean;
  /** 本 PR 当前草稿池快照；FindingCard 据此显示 status chip + 决定 reject 行为 */
  drafts: ReadonlyArray<ReviewDraft>;
  /** 点击 finding card 上"→ 跳到代码编辑"时触发。父组件做懒创建 + 跳转 */
  onJumpToDraft: (finding: Finding, run: ReviewRun) => void;
  /** 拒绝某条 finding：创建 / 更新草稿到 status='rejected' */
  onRejectFinding: (finding: Finding, run: ReviewRun) => void;
  /** 点击 finding 锚点：仅导航到 Diff 对应行（不进编辑态） */
  onNavigateToFinding: (finding: Finding) => void;
}) {
  const findings = run.findings ?? [];
  // 失败 + 取消都用红 banner 提示。取消是用户主动行为，UI 用更轻文案区分
  const isFailed = run.status === 'failed';
  const isCancelled = run.status === 'cancelled';
  const isFailedOrCancelled = isFailed || isCancelled;
  const stderr = run.stderr ?? '';
  const stdout = run.stdout ?? '';
  // "原始输出" 折叠区独立 per-run 维护状态，互不影响。失败 / 取消默认展开方便排障，
  // 成功默认关闭只是诊断兜底
  const [showRawStdout, setShowRawStdout] = useState(isFailedOrCancelled);
  // /ask 工具：把用户提问展示在 meta 行**下方**，跟 /ask 这个动作绑成一组；
  // 上方再放用户气泡会跟 meta 行重复信息源，移到动作下方更符合"动作 → 输入"语序
  const userMessage = run.tool === 'ask' ? run.question?.trim() : undefined;
  return (
    <div className="chat-run-result">
      <RunMeta run={run} />
      {userMessage && (
        <div className="chat-user-msg" aria-label="用户提问">
          <QuestionIcon />
          <div className="chat-user-msg-body">{userMessage}</div>
        </div>
      )}
      {/* 原始输出：始终紧跟 meta 行，让用户在任何状态下都能在固定位置找到日志。
          失败 / 取消默认展开，成功默认收起 */}
      {stdout.length > 0 && (
        <details
          className="chat-run-raw"
          open={showRawStdout}
          onToggle={(e) => {
            if (e.currentTarget.open !== showRawStdout) setShowRawStdout(e.currentTarget.open);
          }}
        >
          <summary>原始输出 ({stdout.length} chars)</summary>
          <AnsiPre className="chat-run-stdout" text={stdout} />
        </details>
      )}
      {isFailedOrCancelled && (
        <div className="chat-error" role="alert">
          <strong>
            {isCancelled
              ? '已取消'
              : run.errorReason === 'llm-error'
                ? 'LLM 调用失败'
                : `run 失败${run.errorReason ? ` (${run.errorReason})` : ''}`}
            {/* llm-error 时 exitCode 是 0 (pr-agent 自己 catch 了)，显示出来反而
                让用户误以为没出错，所以跳过 */}
            {run.exitCode != null && !isCancelled && run.errorReason !== 'llm-error' &&
              ` · exit ${String(run.exitCode)}`}
          </strong>
          {canRetry && (
            <button
              type="button"
              className="chat-run-retry"
              onClick={() => onRetry(run)}
              title={`重试 /${run.tool}${run.question ? ` ${run.question}` : ''}`}
              aria-label="重试"
            >
              <RetryIcon />
            </button>
          )}
          {run.errorMessage && !isCancelled && (
            <pre className="chat-error-detail">{run.errorMessage}</pre>
          )}
          {/* 失败时 stderr 是排障的关键，默认展开。stdout 不再在这里重复展示 ——
              已经放到上方"原始输出"统一位置了 */}
          {stderr.length > 0 && (
            <details className="chat-error-stderr" open>
              <summary>stderr ({stderr.length} chars)</summary>
              <AnsiPre className="chat-run-stdout" text={stderr} />
            </details>
          )}
        </div>
      )}

      {findings.length > 0 ? (
        <ul className="chat-finding-list">
          {orderFindings(findings).map((f) => {
            // 同 run 内 finding 跟草稿一对一：source.runId+findingId 反查。命中后
            // FindingCard 据此显示状态 chip + 跳转/拒绝按钮行为分支
            const relatedDraft = drafts.find(
              (d) =>
                d.source !== undefined &&
                d.source.runId === run.id &&
                d.source.findingId === f.id,
            );
            return (
              <FindingCard
                key={f.id}
                finding={f}
                relatedDraft={relatedDraft}
                onJump={() => onJumpToDraft(f, run)}
                onReject={() => onRejectFinding(f, run)}
                onNavigate={() => onNavigateToFinding(f)}
              />
            );
          })}
        </ul>
      ) : run.status === 'succeeded' ? (
        <div className="chat-finding-empty muted">
          PR Agent 跑完没有解析出 finding（可能 /describe 仅返回摘要、或解析器跳过了未识别段）。
          可以展开上方原始输出核对。
        </div>
      ) : null}
    </div>
  );
}

/**
 * Finding card 上的草稿状态 chip + 操作按钮。仅 code-feedback + anchor 完整时出现。
 *
 * 状态可视化：
 * - 无 relatedDraft（用户从未交互）→ 不显示 status chip，只展示"→ 编辑 / ✗ 拒绝"按钮
 * - pending → 蓝 chip "待处理" + 跳转 + 拒绝
 * - edited → 蓝 chip "已编辑" + 跳转 + 拒绝
 * - posted → 绿 chip "已发布" + 跳转 (查看)，无拒绝 (远端已存，本地不该撤销)
 * - rejected → 灰 chip "已拒绝" + 撤销 (即重新跳转编辑)
 */
function FindingDraftActions({
  relatedDraft,
  onJump,
  onReject,
}: {
  relatedDraft?: ReviewDraft;
  onJump?: () => void;
  onReject?: () => void;
}) {
  const status = relatedDraft?.status;
  const chipText: Record<NonNullable<typeof status>, string> = {
    pending: '待处理',
    edited: '已编辑',
    posted: '已发布',
    rejected: '已拒绝',
  };
  return (
    <div className="chat-finding-draft-actions">
      {status && (
        <span className={`chat-finding-draft-chip chat-finding-draft-chip-${status}`}>
          {chipText[status]}
        </span>
      )}
      {/* posted 后跳转只是"查看"语义，不再有编辑动作；rejected 跳转即"撤销并继续编辑" */}
      {onJump && (
        <button
          type="button"
          className="chat-finding-draft-btn"
          onClick={onJump}
          title={
            status === 'posted'
              ? '查看远端评论'
              : status === 'rejected'
                ? '恢复并编辑'
                : '在代码中编辑'
          }
        >
          {status === 'posted' ? '查看' : status === 'rejected' ? '恢复' : '编辑'}
        </button>
      )}
      {/* posted 不允许 reject (远端已存)；rejected 也不允许 reject (已经是了) */}
      {onReject && status !== 'posted' && status !== 'rejected' && (
        <button
          type="button"
          className="chat-finding-draft-btn chat-finding-draft-btn-reject"
          onClick={onReject}
          title="拒绝此条建议（不会发布到远端）"
        >
          拒绝
        </button>
      )}
    </div>
  );
}

interface TokenUsage {
  /** 输入侧 (prompt) token 数。LITELLM_LOG=INFO 时来自 litellm；fallback 用 pr-agent
      自己打的 "Tokens: N" (tiktoken 预估) */
  prompt?: number;
  /** 输出侧 (completion) token 数。仅 LITELLM_LOG=INFO 时可拿到 */
  completion?: number;
  /** 总 token；优先用 litellm 给的，缺时算 prompt+completion */
  total?: number;
}

/**
 * 从 pr-agent stdout 解析 token 用量。多源累加：
 *
 * 1. litellm INFO 模式 (我们默认开)：每次 LLM 调用后会打类似
 *    `usage={'prompt_tokens': 8423, 'completion_tokens': 1234, 'total_tokens': 9657}`
 *    多轮调用 → 各项累加；这条最准
 *
 * 2. pr-agent 自己的 prompt 预估：`Tokens: 8423, total tokens under limit: ...`
 *    没 litellm 日志兜底；只反映输入侧，按最大值取代表
 *
 * 优先用 (1)；(1) 没命中再退到 (2)。
 */
function extractTokenUsage(stdout: string): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let hasLitellm = false;
  // litellm 的 usage dict 在 stdout 里以 Python repr 形式出现，单引号字符串
  // (兼容 JSON 双引号也匹配)。一次 run 多轮 LLM 调用全部累加
  const usageRe =
    /['"]prompt_tokens['"]\s*:\s*(\d+)[\s,]*['"]completion_tokens['"]\s*:\s*(\d+)[\s,]*['"]total_tokens['"]\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = usageRe.exec(stdout)) !== null) {
    hasLitellm = true;
    prompt += Number.parseInt(m[1]!, 10) || 0;
    completion += Number.parseInt(m[2]!, 10) || 0;
    total += Number.parseInt(m[3]!, 10) || 0;
  }
  if (hasLitellm) {
    return { prompt, completion, total: total || prompt + completion };
  }
  // Fallback: pr-agent 的 prompt 预估
  const fallbackRe = /Tokens:\s*(\d+)/gi;
  let maxPrompt: number | undefined;
  while ((m = fallbackRe.exec(stdout)) !== null) {
    const n = Number.parseInt(m[1]!, 10);
    if (!Number.isNaN(n) && (maxPrompt === undefined || n > maxPrompt)) maxPrompt = n;
  }
  return maxPrompt !== undefined ? { prompt: maxPrompt } : {};
}

/** 1234 → "1.2k"；保留 1 位小数；< 1000 直接返回数字 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

const RUN_STATUS_LABEL: Record<ReviewRun['status'], string> = {
  running: '运行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

function RunMeta({ run }: { run: ReviewRun }) {
  const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
  // 优先用 run.tokenUsage（litellm callback 捕获的 API 真实 usage，见 sitecustomize）；
  // 历史 run 没这字段时回退到从 stdout 抓取的旧估算，保持向后兼容。
  const usage: TokenUsage = run.tokenUsage
    ? {
        prompt: run.tokenUsage.promptTokens,
        completion: run.tokenUsage.completionTokens,
        total: run.tokenUsage.totalTokens,
      }
    : run.stdout
      ? extractTokenUsage(run.stdout)
      : {};
  return (
    <header className="chat-run-meta">
      <span className={`chat-run-tool chat-run-tool-${run.tool}`}>/{run.tool}</span>
      <span className={`chat-run-status chat-run-status-${run.status}`}>
        {RUN_STATUS_LABEL[run.status]}
      </span>
      {/* 模型 chip 取代运行时策略 chip — strategy 是部署细节用户不
          关心，model 是真正影响 review 质量的变量 */}
      {run.model && (
        <span className="chat-run-chip chat-run-model" title={`使用模型 ${run.model}`}>
          {run.model}
        </span>
      )}
      {/* 只分别展示输入(↑prompt,绿) / 输出(↓completion,红)，不显示总数。旧 run 可能只有 prompt */}
      {usage.prompt !== undefined || usage.completion !== undefined ? (
        <span
          className="chat-run-chip chat-run-tokens"
          title={`输入(prompt) ${usage.prompt ?? '—'} · 输出(completion) ${usage.completion ?? '—'} tokens`}
        >
          {usage.prompt !== undefined && (
            <>
              <span style={{ color: '#22c55e' }}>↑</span>
              {formatTokens(usage.prompt)}
            </>
          )}
          {usage.prompt !== undefined && usage.completion !== undefined ? ' / ' : ''}
          {usage.completion !== undefined && (
            <>
              <span style={{ color: '#ef4444' }}>↓</span>
              {formatTokens(usage.completion)}
            </>
          )}
        </span>
      ) : null}
      <span className="chat-run-chip chat-run-duration">{duration}</span>
      {/* 开始时间：纯文本不带胶囊背景，margin-left:auto 顶到最右 — 跟左侧
          tool/status/strategy chip 拉开距离，视觉权重比 chip 轻一档 */}
      <span
        className="chat-run-time"
        title={`开始于 ${new Date(run.startedAt).toLocaleString()}`}
      >
        {formatStartTime(run.startedAt)}
      </span>
    </header>
  );
}

/**
 * 把时间戳格式化为 "HH:MM:SS" (当天) 或 "MM-DD HH:MM" (跨日)。用户主要看"哪一次
 * 跑的"，秒粒度足够区分相邻 run；隔天的 run 加日期标识让历史 run 列表里能立刻
 * 分组。接受 ISO 字符串 (持久化 ReviewRun.startedAt) 或毫秒时间戳 (RunningView
 * 端把 ISO 转过的 Date.getTime())
 */
function formatStartTime(input: string | number): string {
  const d = new Date(input);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}`;
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
  'code-suggestion': 7, // 跟 code-feedback 一组，UI 顺序无优先关系
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
  'code-suggestion': '改进建议',
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

function FindingCard({
  finding,
  relatedDraft,
  onJump,
  onReject,
  onNavigate,
}: {
  finding: Finding;
  /** 该 finding 关联的草稿；undefined = 尚未交互过；不为空 = 已 pending / edited / rejected / posted */
  relatedDraft?: ReviewDraft;
  /** 「→ 跳到代码编辑」按钮回调 */
  onJump?: () => void;
  /** 「✗ 拒绝」按钮回调 */
  onReject?: () => void;
  /** 点击锚点：仅导航到 Diff 对应行（不进编辑态） */
  onNavigate?: () => void;
}) {
  // sectionKey 优先（新解析的），fallback 到 category (旧持久化的 run)
  const key: PrDocSectionKey = finding.sectionKey ?? 'general';
  const label = SECTION_LABEL[key];
  // 标题在已知 sectionKey 上**通常**跟 chip label 内容重复 (h4 显示 "PR Type" + chip
  // 显示 "类型")，所以默认只有 general 段才出 title。但 pr-agent 把若干段的"值"放在
  // 标题里 (e.g., `Estimated effort to review: 3 🔵🔵🔵⚪⚪` / `Score: 85 🟢🟢...`)，
  // body 是空的；这种情况强制把 title 渲染出来，否则卡片只剩 chip 一片空白。
  // 先剥 [file:...] 末尾 marker (pr-agent /review 的 anchor 注入用，用户不可见)
  // 再走 pr-agent 模板翻译。bodyEmpty 也按 stripped 后判断
  const strippedBody = stripFindingMarker(finding.body);
  const bodyEmpty = !strippedBody.trim();
  const showTitle = !!finding.title && (key === 'general' || bodyEmpty);
  // pr-agent 把若干 section 标题 / 固定模板字符串硬编码成英文 (CONFIG__RESPONSE_LANGUAGE
  // 只翻译 LLM 内容值)，渲染前替换成中文
  const translatedBody = translatePrAgentLabels(strippedBody);
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
          {finding.anchor.startLine !== undefined && onNavigate ? (
            // 可点击：跳转到 Diff 对应行（scroll+highlight，不进编辑态）
            <button
              type="button"
              className="chat-finding-anchor-link"
              onClick={onNavigate}
              title="跳转到代码对应行"
            >
              <code>{finding.anchor.path}</code>
              <span>
                :{finding.anchor.startLine}
                {finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine
                  ? `-${String(finding.anchor.endLine)}`
                  : ''}
              </span>
            </button>
          ) : (
            <>
              <code>{finding.anchor.path}</code>
              {finding.anchor.startLine && (
                <span>
                  :{finding.anchor.startLine}
                  {finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine
                    ? `-${String(finding.anchor.endLine)}`
                    : ''}
                </span>
              )}
            </>
          )}
          {/* /improve 建议带的 1-10 重要度评分；高分加 warning 着色提示 reviewer */}
          {typeof finding.score === 'number' && (
            <span
              className={`chat-finding-score${finding.score >= 8 ? ' chat-finding-score-high' : ''}`}
              title="pr-agent 给出的重要度评分 1-10"
            >
              {finding.score}/10
            </span>
          )}
          {/* M4 草稿状态 chip + 操作按钮：仅锚到具体行的 code-feedback 才展示
              (其它如 summary / description / score 没法变 inline 评论) */}
          {finding.anchor.startLine !== undefined &&
            (onJump || onReject) &&
            key === 'code-feedback' && (
              <FindingDraftActions
                relatedDraft={relatedDraft}
                onJump={onJump}
                onReject={onReject}
              />
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
      {/* /improve 给的 existing → improved 代码对比。两段都是片段，独立 <pre> 块
          + 红/绿背景 模拟 diff 视觉 (不用 Monaco DiffEditor 节省开销) */}
      {finding.codeChange && (
        <div className="chat-finding-code-change">
          {finding.codeChange.existing && (
            <pre
              className="chat-finding-code-change-block chat-finding-code-change-existing"
              aria-label="原代码"
            >
              {finding.codeChange.existing}
            </pre>
          )}
          {finding.codeChange.improved && (
            <pre
              className="chat-finding-code-change-block chat-finding-code-change-improved"
              aria-label="改进代码"
            >
              {finding.codeChange.improved}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function ChatEmpty({
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
  if (!prAgent.available) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon" aria-hidden="true">
          <ChatIcon size={28} />
        </div>
        <p className="chat-empty-title">PR Agent 未就绪</p>
        <p className="chat-empty-sub">
          嵌入式运行时与本机 CLI 都未探测到。打开 Settings 看探测详情后重启应用。
        </p>
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
        <p className="chat-empty-title">需要配置 AI 模型</p>
        <p className="chat-empty-sub">
          配置一个 LLM 模型后即可使用 /review、/describe 等能力。PR 同步等基础功能不受影响。
        </p>
        {onOpenSettings && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={onOpenSettings}
          >
            去设置
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
      <p className="chat-empty-title">{pr ? '可以开始对话' : '选中一个 PR 后开始'}</p>
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

