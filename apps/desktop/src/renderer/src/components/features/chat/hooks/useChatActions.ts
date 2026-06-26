import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { PragentRunInfo } from '@meebox/ipc';
import type {
  AgentMessage,
  AgentStep,
  AgentTodoItem,
  Finding,
  PrAgentStatus,
  ReviewDraft,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../../../../api';
import { useChatRunStore } from '../../../../stores/chat-run-store';
import { htmlInlineToMarkdown, stripFindingMarker } from '../utils/findings';

interface UseChatActionsParams {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  llmConfigured: boolean;
  prLocalId: string | undefined;
  /** 本 PR 运行中的活动 run（去重 / 停止全部用）。 */
  myActiveRuns: ReadonlyArray<PragentRunInfo>;
  /** 本 PR 排队中的任务（去重用）。 */
  myWaiting: ReadonlyArray<PragentRunInfo>;
  /** 本 PR 当前草稿池快照；finding ↔ draft 反查。 */
  drafts: ReadonlyArray<ReviewDraft> | null | undefined;
  // 会话态写入口（由 useChatSession 提供）
  setError: Dispatch<SetStateAction<string | null>>;
  setRuns: Dispatch<SetStateAction<ReviewRun[]>>;
  setHasMoreOlder: Dispatch<SetStateAction<boolean>>;
  setAgentSteps: Dispatch<SetStateAction<AgentStep[]>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setTodo: Dispatch<SetStateAction<AgentTodoItem[]>>;
  currentPrIdRef: MutableRefObject<string | undefined>;
  reloadConversation: (localId: string) => Promise<void>;
  // 跨组件跳转回调（由 MainPane / App 注入）
  onJumpToDraftEditor?: (target: {
    runId: string;
    findingId: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
  onNavigateToAnchor?: (anchor: { path: string; startLine: number; endLine: number }) => void;
}

export interface ChatActions {
  /** Agent 运行态（自动评审微流程 / 自由规划对话）：记录各 PR 的起跑时刻（localId → since）。 */
  runningPrs: Map<string, number>;
  /** 仅「跑在当前 PR」才在本会话显示运行态 / 思考中。 */
  agentRunningHere: boolean;
  handleRun: (
    tool: ReviewRunTool,
    question?: string,
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
  ) => Promise<void>;
  handleAgentReview: () => Promise<void>;
  handleAgentAsk: (question: string, referencedContext?: string) => Promise<void>;
  handleClearRuns: () => Promise<void>;
  handleCancel: (runId: string) => Promise<void>;
  handleDeleteRun: (runId: string) => Promise<void>;
  handleStopAll: () => void;
  handleRetry: (run: ReviewRun) => void;
  handleJumpToDraft: (finding: Finding, run: ReviewRun) => Promise<void>;
  handleNavigateToFinding: (finding: Finding) => void;
  handleRejectFinding: (finding: Finding, run: ReviewRun) => Promise<void>;
}

/**
 * ChatPane 的业务动作集合：触发 pr-agent 工具 / 自动评审 / 对话即委派、取消与停止、清空历史、
 * 以及 finding → 草稿的懒创建 / 拒绝 / 导航。并发模型——不同 PR 的 agent 任务可并发 / 排队，仅禁止
 * 对**同一 PR**重复发起；运行态按发起 PR 归属，不串到其它 PR 会话。
 */
export function useChatActions(params: UseChatActionsParams): ChatActions {
  const {
    pr,
    prAgent,
    llmConfigured,
    prLocalId,
    myActiveRuns,
    myWaiting,
    drafts,
    setError,
    setRuns,
    setHasMoreOlder,
    setAgentSteps,
    setMessages,
    setTodo,
    currentPrIdRef,
    reloadConversation,
    onJumpToDraftEditor,
    onNavigateToAnchor,
  } = params;
  const { t } = useTranslation();

  // 记录**各 PR** 的起跑时刻（localId → since）。不同 PR 的 agent 任务可并发 / 排队，仅禁止对同一 PR 重复发起。
  // 本地态只承载**用户手动发起**的乐观即时反馈（不等 main 广播回环）；AutoPilot 后台评审不经此处。
  const [runningPrs, setRunningPrs] = useState<Map<string, number>>(() => new Map());
  // 编排 Agent 运行中的 PR 集合（含纯思考阶段）——来自 store 的 `agent:runningChanged`，手动与 AutoPilot
  // 一并计入，是「是否在跑」的权威来源。
  const { agentPrs } = useChatRunStore();
  // 仅「跑在当前 PR」才在本会话显示运行态 / 思考中；其它 PR 在跑不影响本会话发起（可并发 / 排队）。
  // 取「本地乐观态 ∪ store 权威态」：手动发起即时点亮（本地），AutoPilot 后台评审经 store 点亮——
  // 否则后台评审的纯思考阶段（工具 run 跑完后的 judge / 总结）因 agentRunningHere=false 不显示「思考中」。
  const agentRunningHere =
    prLocalId !== undefined && (runningPrs.has(prLocalId) || agentPrs.includes(prLocalId));

  // 触发 /describe / /review / /ask。队列模型下 active 非空也允许提交，新 run 进
  // 队列，main 端先后串行执行。失败抛 banner；成功不需要手动 setRuns，session effect
  // 会在 active 切换时自动 refresh
  const handleRun = async (
    tool: ReviewRunTool,
    question?: string,
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
  ): Promise<void> => {
    if (!pr || !prAgent.available || !llmConfigured) return;
    // 去重（即时反馈）：同一 PR 同一工具已在执行 / 排队 → 阻止重复触发（main 端亦有
    // 权威校验兜底）。/ask 每次问题不同，不限制。
    if (
      tool !== 'ask' &&
      (myActiveRuns.some((r) => r.tool === tool) || myWaiting.some((w) => w.tool === tool))
    ) {
      setError(t('chatPane.duplicateRun', { tool }));
      return;
    }
    setError(null);
    try {
      await invoke('pragent:run', {
        localId: pr.localId,
        tool,
        question,
        referencedContext,
        referencedFinding,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 一键自动评审：触发 main 的 agent:run（评审微流程）。describe/review/ask 子 run 经既有运行
  // 队列展示在历史里；收尾评审作为一条 assistant 消息落入多轮对话，完成后重载对话呈现。
  const handleAgentReview = async (): Promise<void> => {
    // 仅禁止对同一 PR 重复发起；其它 PR 在跑不阻塞（并发 / 排队）。
    if (!pr || !prAgent.available || !llmConfigured || runningPrs.has(pr.localId)) return;
    const startedId = pr.localId;
    setError(null);
    setAgentSteps([]);
    setRunningPrs((m) => new Map(m).set(startedId, Date.now()));
    try {
      const session = await invoke('agent:run', { localId: startedId });
      await reloadConversation(startedId);
      if (currentPrIdRef.current === startedId && session.status === 'failed') {
        setError(session.terminationReason ?? t('chatPane.agent.failed'));
      }
    } catch (e) {
      if (currentPrIdRef.current === startedId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunningPrs((m) => {
        const next = new Map(m);
        next.delete(startedId);
        return next;
      });
    }
  };

  // 自然语言「对话即委派」：交给自由规划 Agent（agent:ask）。用户输入即时 optimistic 回显，
  // 收尾后以落盘对话（含用户 + 助手消息）整体对齐。
  const handleAgentAsk = async (question: string, referencedContext?: string): Promise<void> => {
    if (!pr || !prAgent.available || !llmConfigured) return;
    const startedId = pr.localId;
    // 中途输入（已有 Agent 在跑）走 enqueueMessage，后端不持久化引用上下文 → 该路径不带 ref，
    // 避免重载对齐时引用块闪烁消失；仅新一轮提问的气泡附带引用上下文。
    const enqueueing = runningPrs.has(startedId);
    // 即时 optimistic 回显用户气泡（运行中 / 新轮都先冒泡，不再静默丢弃中途输入）。
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: question,
        referencedContext: enqueueing ? undefined : referencedContext,
        at: new Date().toISOString(),
      },
    ]);
    // 本 PR 已有 Agent 在跑：不另起一轮，入队到下一主 Agent 周期并入、据最新指令重排（中途输入转向）。
    if (enqueueing) {
      try {
        await invoke('agent:enqueueMessage', { localId: startedId, message: question });
      } catch (e) {
        if (currentPrIdRef.current === startedId) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    setError(null);
    setAgentSteps([]);
    setRunningPrs((m) => new Map(m).set(startedId, Date.now()));
    try {
      const session = await invoke('agent:ask', {
        localId: startedId,
        question,
        referencedContext,
      });
      await reloadConversation(startedId);
      if (currentPrIdRef.current === startedId && session.status === 'failed') {
        setError(session.terminationReason ?? t('chatPane.agent.failed'));
      }
    } catch (e) {
      if (currentPrIdRef.current === startedId) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunningPrs((m) => {
        const next = new Map(m);
        next.delete(startedId);
        return next;
      });
    }
  };

  // 清空当前 PR 的执行历史（仅该 PR）：删远端记录 + 清本地列表，并一并清掉 Agent 收尾结果 /
  // 步骤 / 错误横幅（含「已停止 / 失败」提示），避免清空后仍残留陈旧反馈。进行中的 run 不受影响
  // （在 chatRunStore，跑完会重新落盘）。
  const handleClearRuns = async (): Promise<void> => {
    if (!prLocalId) return;
    try {
      await invoke('pragent:clearRuns', { localId: prLocalId });
      setRuns([]);
      setHasMoreOlder(false);
      setError(null);
      setAgentSteps([]);
      setMessages([]);
      setTodo([]);
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
  // 删除单条已结束的 run 记录（成功 / 失败 / 取消）：删远端记录后乐观从本地列表移除该条。
  // 仅删该 run，不动 Agent 会话 / 台账 / 徽标（与「清空」区分）。
  const handleDeleteRun = async (runId: string): Promise<void> => {
    if (!prLocalId) return;
    try {
      await invoke('pragent:deleteRun', { localId: prLocalId, runId });
      setRuns((prev) => prev.filter((r) => r.id !== runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // 停止本 PR 会话内进行中的全部任务：逐条取消所有活动 run（Agent 并行多选时可能 >1），
  // 并中止 Agent 编排（abort，阻止其在子任务取消后继续后续步骤）。
  const handleStopAll = (): void => {
    for (const r of myActiveRuns) void handleCancel(r.runId);
    if (agentRunningHere && prLocalId) void invoke('agent:stop', { localId: prLocalId });
  };
  const handleRetry = (run: ReviewRun): void => {
    void handleRun(run.tool, run.question);
  };

  /**
   * 把 AI finding body 转成草稿初始 body：先 stripFindingMarker 去掉 [file:...]
   * 末尾 marker，再把 pr-agent GFM 里的内联 HTML 标签归一成 markdown（草稿编辑器是
   * 纯文本，裸 `<code>`/`<br>` 会露馅），最后加 `[AI 建议]` 前缀 — 让远端 reviewer
   * 看到时知道这条评论来自 pr-agent
   */
  const buildDraftBodyFromFinding = (body: string): string =>
    `${t('chatPane.aiSuggestionPrefix')} ${htmlInlineToMarkdown(stripFindingMarker(body))}`;

  /**
   * ChatPane finding card 上点"编辑"按钮的处理：
   * - 已有关联草稿 → 直接 onJumpToDraftEditor，DiffView 打开它
   * - 没有关联草稿 → 懒创建一条 pending + onJumpToDraftEditor
   * - 关联草稿是 rejected → update 回 pending (撤销拒绝) + 跳转
   */
  const handleJumpToDraft = async (finding: Finding, run: ReviewRun): Promise<void> => {
    if (!pr) return;
    if (!finding.anchor || typeof finding.anchor.startLine !== 'number') {
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

  return {
    runningPrs,
    agentRunningHere,
    handleRun,
    handleAgentReview,
    handleAgentAsk,
    handleClearRuns,
    handleCancel,
    handleDeleteRun,
    handleStopAll,
    handleRetry,
    handleJumpToDraft,
    handleNavigateToFinding,
    handleRejectFinding,
  };
}
