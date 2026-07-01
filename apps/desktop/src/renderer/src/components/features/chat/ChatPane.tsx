import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Finding,
  LocalPrStatus,
  PrAgentStatus,
  ReviewRun,
  ReviewRunCommitScope,
  StoredPullRequest,
} from '@meebox/shared';
import { ChatIcon, TrashIcon, ConfirmModal, PaneLoading } from '../../common';
import { useChatRunStore } from '../../../stores/chat-run-store';
import { useDraftsForPr } from '../../../stores/drafts-store';
import { useFindingClosuresForPr } from '../../../stores/finding-closures-store';
import {
  formatReferencedContext,
  selectionStore,
  useDiffSelection,
} from '../../../stores/selection-store';
import { anchorShortLabel, formatFindingReference } from './utils/findings';
import { CHAT_MAX_WIDTH, CHAT_MIN_WIDTH } from './constants';
import { useChatSession } from './hooks/useChatSession';
import { useChatActions } from './hooks/useChatActions';
import { useChatTimeline } from './hooks/useChatTimeline';
import { AgentStepRow, ThinkingLive } from './components/AgentStep';
import { ChatEmpty } from './components/ChatEmpty';
import { ChatInputBar } from './components/ChatInputBar';
import { ConversationMessage } from './components/ConversationMessage';
import { PlanPanel } from './components/PlanPanel';
import { QueuedView } from './components/QueuedView';
import { RulePreviewModal } from './components/RulePreviewModal';
import { RunningView } from './components/RunningView';
import { RunResultView } from './components/RunResultView';

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
  /** /merge 命令触发的合并（弹二次确认后调用，跟 PR header 合并按钮共用 prs:merge）；仅 canMerge 时可用。 */
  onMerge?: () => void;
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
  /** 打开设置面板（LLM 未配置提示里的「去设置」按钮用） */
  onOpenSettings?: () => void;
  /**
   * 当前 Diff 视图选中的单 commit 范围（无 / root commit 为 null）：作为本 PR 聊天区命令的**隐式范围**——
   * 直接键入的 /describe /review /improve /ask 自动限定在该 commit（输入栏显示可撤销范围 chip）。撤销该 chip
   * 后本会话不再随视图范围（直到切换到别的 commit）。auto review 微流程不受此影响、恒作用于 PR 全量。
   */
  viewCommitScope?: ReviewRunCommitScope | null;
}

/**
 * pr-agent 调用面板（M3-D1）。
 * - 头部：两个动作按钮 (/describe /review)，pr-agent 不可用时禁用并指引到 Settings
 * - 运行中：实时滚动 stdout（main 通过 pragent:runProgress 流式推送）
 * - 运行后：展示最新 ReviewRun 的 findings 列表（markdown body + 可选 anchor）
 *
 * 本组件是「容器」：状态与生命周期归 useChatSession，业务动作归 useChatActions，时间线归并归
 * useChatTimeline；展示与工具方法拆到 ./components 与 ./utils。这里只做布局编排与少量纯 UI 态。
 */
export function ChatPane({
  pr,
  prAgent,
  width,
  onResize,
  collapsed,
  onJumpToDraftEditor,
  onSetReviewStatus,
  onMerge,
  onNavigateToAnchor,
  currentLlmModel,
  llmConfigured = true,
  onOpenSettings,
  viewCommitScope,
}: ChatPaneProps) {
  const { t } = useTranslation();
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

  const prLocalId = pr?.localId;

  // 全局活动 run + 实时 stdout 缓存。store 来源于 main 的 'pragent:activeChanged'
  // / 'pragent:runProgress' 事件，PR 切换不丢，所以这里只读，不在本组件维护
  const { active, waiting, linesByRunId } = useChatRunStore();
  // 并发模型：active 是多条并发运行中的 run。本 PR 的运行中 run 可能 >1（用户对同一
  // PR 连发多个工具）；其它 PR 的并发数用于「别处在跑」提示。
  const myActiveRuns = active.filter((a) => a.prLocalId === pr?.localId);
  const hasMyActive = myActiveRuns.length > 0;
  // 本 PR 排队中的任务（FIFO，前面的先跑），在 chat 末尾以「排队中」卡片展示
  const myWaiting = waiting.filter((w) => w.prLocalId === pr?.localId);
  const myActiveIds = myActiveRuns.map((a) => a.runId);

  // M4 草稿池：从 main 进程拉本 PR 的草稿，跟 finding 通过 source 字段反查关联
  const drafts = useDraftsForPr(prLocalId);
  // 复评关闭关系池（只读）：复评 /ask 裁决 replace/drop 时由后端自动关闭原 finding（见 asks-step →
  // closeFinding）并广播；这里据 (runId,findingId) 反查、在 FindingCard 上以只读 chip 标注「已被复评取代/关闭」。
  const closures = useFindingClosuresForPr(prLocalId) ?? [];

  // 复评引用态：点 finding「引用」→ 仅挂到输入栏（chip）；不自动填写问题，用户自行输入。发送时携带该引用。
  const [refFinding, setRefFinding] = useState<{ finding: Finding; run: ReviewRun } | null>(null);
  // 「脱离视图范围」态：用户 ✕ 掉范围 chip 后，本会话命令不再随 Diff 视图选中的 commit（直到切到别的 commit
  // 或切 PR 才复位）。默认跟随视图范围。
  const [scopeDetached, setScopeDetached] = useState(false);
  // PR 切换清掉引用态、复位脱离态，避免跨 PR 残留。
  useEffect(() => {
    setRefFinding(null);
    setScopeDetached(false);
  }, [prLocalId]);
  // 切到别的 commit（或清空视图范围）时复位脱离态：新选中的 commit 重新作为隐式范围生效。
  useEffect(() => {
    setScopeDetached(false);
  }, [viewCommitScope?.sha]);
  const onReferenceFinding = (finding: Finding, run: ReviewRun): void => {
    setRefFinding({ finding, run });
  };

  // Diff 选区（归属当前 PR）：用于输入栏「N 行已选中」角标 + 把选中代码作为隐式上下文带进提问。
  const { selection: diffSelection, ignored: selectionIgnored } = useDiffSelection(prLocalId);
  // 未忽略时把选区拼成引用串；/ask 与自然语言提问共用。忽略 / 无选区 → undefined（本条不带引用）。
  const referencedContext =
    diffSelection && !selectionIgnored ? formatReferencedContext(diffSelection) : undefined;

  // 本 PR 聊天区命令的生效范围：跟随 Diff 视图选中的 commit，除非用户已脱离（scopeDetached）。
  // 同一时刻只允许一个 scope 生效——存在 Diff 选区时以选区为准（更细粒度），commit 范围暂挂起、其 chip
  // 亦隐藏（见 commitScopeChip），取消选区后自动还原。
  const effectiveScope = diffSelection || scopeDetached ? null : (viewCommitScope ?? null);

  // 会话态 + 生命周期（切 PR 重载 / 流式步骤 / 分页 / 自动滚动）
  const session = useChatSession(prLocalId, myActiveIds);

  // 切走再回来时，正在跑的 run 已落盘 (status=running) → listRuns 把它读进 runs，
  // 同时它又是实时运行中 run，会重复渲染 (历史卡片 + RunningView 各一条)。这里把
  // 所有运行中 run 从历史列表剔除，运行中的展示统一交给下方 RunningView 负责。
  const myActiveIdSet = new Set(myActiveIds);
  const visibleRuns = hasMyActive
    ? session.runs.filter((r) => !myActiveIdSet.has(r.id))
    : session.runs;

  // 业务动作集合（触发工具 / 自动评审 / 对话 / 取消 / 清空 / finding→草稿）
  const actions = useChatActions({
    pr,
    prAgent,
    llmConfigured,
    prLocalId,
    myActiveRuns,
    myWaiting,
    drafts,
    setError: session.setError,
    setRuns: session.setRuns,
    setHasMoreOlder: session.setHasMoreOlder,
    setAgentSteps: session.setAgentSteps,
    setMessages: session.setMessages,
    setTodo: session.setTodo,
    currentPrIdRef: session.currentPrIdRef,
    reloadConversation: session.reloadConversation,
    onJumpToDraftEditor,
    onNavigateToAnchor,
  });
  const { agentRunningHere } = actions;

  // 发送一条复评 /ask：携带被引用 finding 的结构化引用 + 正文上下文，走 /ask 直达工具（出裁决 +
  // 采纳/关闭动作）；发送后清空引用态。
  const sendReferencedAsk = (q: string): void => {
    if (!refFinding) return;
    const { finding, run } = refFinding;
    void actions.handleRun('ask', q, formatFindingReference(finding), {
      runId: run.id,
      findingId: finding.id,
      anchor: finding.anchor,
    });
    setRefFinding(null);
  };

  // 发送一条限定在当前视图 commit 的 /ask：把生效范围随问题带下去（限定 parent..sha 的 diff）。
  const sendScopedAsk = (q: string): void => {
    if (!effectiveScope) return;
    void actions.handleRun('ask', q, undefined, undefined, effectiveScope);
  };

  // 历史时间线归并 + 「思考中」实时计时锚点
  const { timeline, thinkingSince } = useChatTimeline({
    visibleRuns,
    myActiveRuns,
    agentSteps: session.agentSteps,
    messages: session.messages,
    runningPrs: actions.runningPrs,
    prLocalId,
  });

  // 纯 UI 态：规则预览弹窗 / 清空确认弹窗 / 合并确认弹窗
  const [showRulePreview, setShowRulePreview] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);

  const { runs, error, loadingSession, matchedRules, bodyRef, hasMoreOlder, loadingOlder } = session;

  // 复评卡 ↔ 原 finding 卡互链：滚动定位 + 短暂高亮。flash class 因目标而异：run 卡用 chat-run-flash
  // （背景渐隐，run 卡本身透明底可见）；finding 卡用 chat-finding-flash（覆盖式高亮环——finding 卡有
  // 实底 $bg-elev，背景渐隐会被洗掉、看不出闪烁）。
  const flash = (el: Element, cls: 'chat-run-flash' | 'chat-finding-flash'): void => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 1600);
  };
  const scrollToRun = (runId: string): void => {
    const el = bodyRef.current?.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
    if (el) flash(el, 'chat-run-flash');
  };
  // 点击复评卡顶部引用徽标：精确定位到原 run 内被引用的那条 finding 卡片并闪烁高亮（找不到该卡片——
  // 如已分页移出 / 折叠——回退到整条 run 高亮，至少给出定位反馈）。
  const scrollToFinding = (runId: string, findingId: string): void => {
    const runEl = bodyRef.current?.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
    if (!runEl) return;
    const findingEl = runEl.querySelector(`[data-finding-id="${CSS.escape(findingId)}"]`);
    if (findingEl) flash(findingEl, 'chat-finding-flash');
    else flash(runEl, 'chat-run-flash');
  };

  return (
    <aside
      className={`chat-pane${collapsed ? ' chat-pane-collapsed' : ''}`}
      style={{ width: `${String(width)}px` }}
      aria-label={t('chatPane.paneAria')}
      aria-hidden={collapsed ? true : undefined}
    >
      <div
        className="chat-pane-resize-handle"
        onMouseDown={startResize}
        title={t('chatPane.resizeWidthTitle')}
        aria-label={t('chatPane.resizeWidthAria')}
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
        {pr && runs.length > 0 && (
          <button
            type="button"
            className="icon-btn chat-pane-clear"
            title={t('chatPane.clearHistoryTitle')}
            aria-label={t('chatPane.clearHistoryAria')}
            onClick={() => setShowClearConfirm(true)}
          >
            <TrashIcon />
          </button>
        )}
      </header>

      {/* 当前 PR 命中的规则 chip：rules.dir 未配置 / 整体禁用 / 无命中 → 不显示。
          点击展开正文预览，让用户能确认本次 review 会被哪条规则约束 */}
      {matchedRules.length > 0 && (
        <button
          type="button"
          className="chat-rule-chip"
          onClick={() => setShowRulePreview(true)}
          title={t('chatPane.ruleChipTitle')}
        >
          <span className="chat-rule-chip-label">{t('chatPane.ruleChipLabel')}</span>
          <span className="chat-rule-chip-id">
            {matchedRules.length === 1
              ? matchedRules[0]!.id
              : `${matchedRules[0]!.id} +${String(matchedRules.length - 1)}`}
          </span>
        </button>
      )}

      {/* 规划 Agent 的计划面板：运行中据 agent:planUpdated 实时刷新、随新输入重排；空计划不渲染。
          置于 header 之下、滚动区之上，始终可见。 */}
      <PlanPanel todo={session.todo} />

      <div className="chat-pane-body" ref={bodyRef}>
        {/* 初次拉取会话期间盖延迟 loading（>150ms 才显），遮住「清空 → 内容 pop-in」抖动；
            加载完成才落到下方的真实空态，避免空 PR 误显 loading。 */}
        {loadingSession && <PaneLoading />}
        {/* 使用提示仅在「全无会话内容」时显示：一旦有用户输入气泡 / run / 步骤 / 收尾结果，
            或 Agent 正在运行 / 有排队任务，即隐藏，避免输入后仍残留提示。 */}
        {!loadingSession &&
          timeline.length === 0 &&
          !agentRunningHere &&
          !hasMyActive &&
          myWaiting.length === 0 && (
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
            {loadingOlder ? t('common.loading') : t('chatPane.scrollUpForOlder')}
          </div>
        )}
        {/* 历史 run 按时间升序堆叠，每条独立卡片 (内部维护自己的 raw stdout 折叠状态)。
            初始只拉最新 RUNS_PAGE_SIZE 条；向上滚到顶后再用游标拉更早一批 */}
        {timeline.map((entry, i) =>
          entry.run ? (
            // data-run-id：供复评卡 ↔ 原 finding 卡互链滚动定位（scrollToRun）。
            <div key={entry.key} data-run-id={entry.run.id}>
              <RunResultView
                run={entry.run}
                onRetry={actions.handleRetry}
                onDelete={actions.handleDeleteRun}
                // 只有"时间线里最后一条 run + 没有正在跑的"这一种情形下，失败 / 取消的 run
                // 才可重试；用户已经发起新动作 (无论成功或正在跑) → 旧失败不再展示重试，
                // 避免回头再点重新插队、打乱对话顺序
                canRetry={i === timeline.length - 1 && !hasMyActive}
                drafts={drafts ?? []}
                closures={closures}
                onJumpToDraft={actions.handleJumpToDraft}
                onRejectFinding={actions.handleRejectFinding}
                onNavigateToFinding={actions.handleNavigateToFinding}
                onReferenceFinding={onReferenceFinding}
                onScrollToRun={scrollToRun}
                onScrollToFinding={scrollToFinding}
              />
            </div>
          ) : entry.active ? (
            // 正在跑：进度条 + 实时 stdout 流，按启动时间穿插在时间线里（startedAt 入队时为 null、
            // 起跑时设值，fallback enqueuedAt）。prAgent 未就绪时不渲染。
            prAgent.available ? (
              <RunningView
                key={entry.key}
                tool={entry.active.tool}
                runId={entry.active.runId}
                question={entry.active.question}
                scope={entry.active.scope}
                lines={linesByRunId.get(entry.active.runId) ?? []}
                startedAt={new Date(entry.active.startedAt ?? entry.active.enqueuedAt).getTime()}
                model={currentLlmModel ?? null}
              />
            ) : null
          ) : entry.step ? (
            <AgentStepRow key={entry.key} step={entry.step} />
          ) : entry.message ? (
            <ConversationMessage key={entry.key} message={entry.message} />
          ) : null,
        )}
        {/* 本 PR 排队中的任务：贴在运行中之后，可单条取消。位次取**全局**队列位序（队列跨 PR 共享，
            否则每个 PR 都显示「第 1 位」会误导）——以 runId 在全局 waiting 数组里的下标 +1 为序。 */}
        {myWaiting.map((w) => (
          <QueuedView
            key={w.runId}
            tool={w.tool}
            question={w.question}
            position={waiting.findIndex((x) => x.runId === w.runId) + 1}
            onCancel={() => void actions.handleCancel(w.runId)}
          />
        ))}
        {/* 过程化跟踪（类 Claude Code）：已完成的思考步骤已按时间穿插进上面的时间线（AgentStepRow），
            此处只在 Agent 自身 LLM 正在推理（无 pr-agent 工具 run 占用 / 排队）时补一条实时「思考中」
            指示——等待工具调用不算思考。计时锚定到「最近一次活动结束」（run 起点 / 末步 / 末个完成
            run 的结束时刻取最晚者）而非组件挂载——切换 PR 再切回不会清零（runningPrs 与 run 历史持久）。 */}
        {agentRunningHere && !hasMyActive && myWaiting.length === 0 && (
          <ThinkingLive since={thinkingSince} />
        )}
        {error && (
          <div className="chat-error" role="alert">
            <strong>{t('chatPane.errorPrefix')}</strong>
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
        // referencedContext 仅 /ask 与自然语言提问携带选区引用（describe/review 不带）。
        // 引用了 finding 时：本条强制走复评 /ask（携带 finding 引用 + 正文上下文），发送后清空引用。
        onRun={(tool, q) => {
          if (tool === 'ask' && refFinding) {
            sendReferencedAsk(q ?? '');
            return;
          }
          if (tool === 'ask' && effectiveScope) {
            sendScopedAsk(q ?? '');
            return;
          }
          // describe/review/improve 亦跟随视图 commit 范围（effectiveScope）；无范围时为 PR 全量。
          void actions.handleRun(
            tool,
            q,
            tool === 'ask' ? referencedContext : undefined,
            undefined,
            tool === 'ask' ? undefined : (effectiveScope ?? undefined),
          );
        }}
        onAgentAsk={(q) => {
          if (refFinding) {
            sendReferencedAsk(q);
            return;
          }
          // 视图选中某 commit 时，自然语言提问也走该 commit 范围的 /ask（限定该 commit 的 diff）。
          if (effectiveScope) {
            sendScopedAsk(q);
            return;
          }
          void actions.handleAgentAsk(q, referencedContext);
        }}
        onCancel={hasMyActive || agentRunningHere ? actions.handleStopAll : undefined}
        onSetReviewStatus={onSetReviewStatus}
        // /merge：仅远端可直接合并时在命令菜单出现；触发先弹二次确认，确认后才实际合并。
        canMerge={pr?.mergeStatus?.canMerge ?? false}
        onMerge={onMerge ? () => setShowMergeConfirm(true) : undefined}
        // 一键自动评审：图标按钮置于 `/` 命令触发器右侧。runningHere=跑在当前 PR（高亮 / 运行中文案 +
        // 禁用重复发起）；其它 PR 在跑不禁用本 PR 的触发（可并发 / 排队）。
        agentRunningHere={agentRunningHere}
        onAgentReview={() => void actions.handleAgentReview()}
        // Diff 选区角标：N 行已选中 / 点击切忽略；无选区时 null（不渲染）。
        selectionLineCount={diffSelection?.lineCount ?? null}
        selectionIgnored={selectionIgnored}
        onToggleSelection={() => selectionStore.toggleIgnored()}
        // 复评引用：chip（直接显示引用定位 <file:line> + 清除）；点 finding「引用」时挂上，不自动填写问题。
        referenceChip={
          refFinding
            ? {
                label: anchorShortLabel(refFinding.finding.anchor),
                onClear: () => {
                  setRefFinding(null);
                },
              }
            : null
        }
        // 单 commit 范围 chip：视图选中某 commit 时显示（选中态源自视图）；点击切换启用/禁用——
        // 禁用（scopeDetached）时命令回到 PR 全量、chip 置灰，切到别的 commit 或切 PR 复位为启用。
        // 同一时刻只允许一个 scope：存在 Diff 选区时让位于选区 chip（隐藏本 chip），取消选区后自动还原。
        commitScopeChip={
          viewCommitScope && !diffSelection
            ? {
                label: `${viewCommitScope.abbreviatedSha} · ${viewCommitScope.subject}`,
                disabled: scopeDetached,
                onToggle: () => {
                  setScopeDetached((d) => !d);
                },
              }
            : null
        }
      />

      {showRulePreview && matchedRules.length > 0 && (
        <RulePreviewModal rules={matchedRules} onClose={() => setShowRulePreview(false)} />
      )}
      {showClearConfirm && (
        <ConfirmModal
          title={t('chatPane.clearConfirmTitle')}
          message={t('chatPane.clearConfirmMessage')}
          confirmLabel={t('chatPane.clearConfirmLabel')}
          danger
          onConfirm={() => {
            setShowClearConfirm(false);
            void actions.handleClearRuns();
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
      {showMergeConfirm && (
        <ConfirmModal
          title={t('chatPane.mergeConfirmTitle')}
          message={t('chatPane.mergeConfirmMessage', { title: pr?.title ?? '' })}
          confirmLabel={t('chatPane.mergeConfirmLabel')}
          onConfirm={() => {
            setShowMergeConfirm(false);
            onMerge?.();
          }}
          onCancel={() => setShowMergeConfirm(false)}
        />
      )}
    </aside>
  );
}
