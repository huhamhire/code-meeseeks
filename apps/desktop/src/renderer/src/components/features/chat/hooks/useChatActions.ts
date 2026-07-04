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
  /** Active runs in progress for this PR (used for dedup / stop-all). */
  myActiveRuns: ReadonlyArray<PragentRunInfo>;
  /** Queued tasks for this PR (used for dedup). */
  myWaiting: ReadonlyArray<PragentRunInfo>;
  /** Current draft pool snapshot for this PR; finding ↔ draft reverse lookup. */
  drafts: ReadonlyArray<ReviewDraft> | null | undefined;
  // Session-state write entry points (provided by useChatSession)
  setError: Dispatch<SetStateAction<string | null>>;
  setRuns: Dispatch<SetStateAction<ReviewRun[]>>;
  setHasMoreOlder: Dispatch<SetStateAction<boolean>>;
  setAgentSteps: Dispatch<SetStateAction<AgentStep[]>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setTodo: Dispatch<SetStateAction<AgentTodoItem[]>>;
  currentPrIdRef: MutableRefObject<string | undefined>;
  reloadConversation: (localId: string) => Promise<void>;
  // Cross-component jump callbacks (injected by MainPane / App)
  onJumpToDraftEditor?: (target: {
    runId: string;
    findingId: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
  onNavigateToAnchor?: (anchor: { path: string; startLine: number; endLine: number }) => void;
}

export interface ChatActions {
  /** Agent running state (auto-review micro-flow / free-planning conversation): records the start time of each PR (localId → since). */
  runningPrs: Map<string, number>;
  /** Only when "running on the current PR" does this session show running / thinking state. */
  agentRunningHere: boolean;
  handleRun: (
    tool: ReviewRunTool,
    question?: string,
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
    scope?: ReviewRun['scope'],
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
 * ChatPane's set of business actions: trigger pr-agent tools / auto-review / conversation-as-delegation,
 * cancel and stop, clear history, plus lazy creation / rejection / navigation of finding → draft. Concurrency
 * model — agent tasks on different PRs can run concurrently / queue; only repeated triggers on the **same PR**
 * are forbidden; running state belongs to the initiating PR and does not bleed into other PR sessions.
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

  // Records the start time of **each PR** (localId → since). Agent tasks on different PRs can run concurrently / queue; only repeated triggers on the same PR are forbidden.
  // Local state only carries the optimistic immediate feedback of **user manual triggers** (does not wait for the main broadcast round-trip); AutoPilot background review does not go through here.
  const [runningPrs, setRunningPrs] = useState<Map<string, number>>(() => new Map());
  // Set of PRs with the orchestrating Agent running (including pure thinking phase) — from the store's `agent:runningChanged`, counting both manual and AutoPilot;
  // it is the authoritative source for "is it running".
  const { agentPrs } = useChatRunStore();
  // Only when "running on the current PR" does this session show running / thinking state; other PRs running does not affect triggering in this session (can run concurrently / queue).
  // Takes "local optimistic state ∪ store authoritative state": manual triggers light up immediately (local), AutoPilot background review lights up via the store —
  // otherwise the pure thinking phase of background review (judge / summary after the tool run finishes) would not show "thinking" because agentRunningHere=false.
  const agentRunningHere =
    prLocalId !== undefined && (runningPrs.has(prLocalId) || agentPrs.includes(prLocalId));

  // Triggers /describe / /review / /ask. Under the queue model, submitting is allowed even when active is non-empty; the new run enters
  // the queue and main executes them serially in order. Failures throw a banner; success needs no manual setRuns, the session effect
  // auto-refreshes when active changes
  const handleRun = async (
    tool: ReviewRunTool,
    question?: string,
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
    scope?: ReviewRun['scope'],
  ): Promise<void> => {
    if (!pr || !prAgent.available || !llmConfigured) return;
    // Dedup (immediate feedback): if the same tool for the same PR is already executing / queued → block the repeated trigger (main also has
    // authoritative validation as a fallback). /ask has a different question each time, and single-commit scope is a targeted action, so neither is restricted (same criteria as backend dedup).
    if (
      tool !== 'ask' &&
      !scope &&
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
        scope,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // One-click auto-review: triggers main's agent:run (review micro-flow). The describe/review/ask sub-runs are shown in history via the existing run
  // queue; the concluding review lands as an assistant message in the multi-turn conversation, and the conversation is reloaded for display after completion.
  const handleAgentReview = async (): Promise<void> => {
    // Only repeated triggers on the same PR are forbidden; other PRs running does not block (concurrent / queued).
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

  // Natural-language "conversation-as-delegation": hand off to the free-planning Agent (agent:ask). User input is echoed optimistically at once,
  // and after completion aligned wholesale against the persisted conversation (including user + assistant messages).
  const handleAgentAsk = async (question: string, referencedContext?: string): Promise<void> => {
    if (!pr || !prAgent.available || !llmConfigured) return;
    const startedId = pr.localId;
    // Mid-flight input (an Agent already running) goes through enqueueMessage; the backend does not persist referenced context → this path carries no ref,
    // to avoid the reference block flickering away on reload alignment; only the bubble of a new-round ask carries referenced context.
    const enqueueing = runningPrs.has(startedId);
    // Echo the user bubble optimistically at once (both running / new-round bubble first, no longer silently discarding mid-flight input).
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: question,
        referencedContext: enqueueing ? undefined : referencedContext,
        at: new Date().toISOString(),
      },
    ]);
    // An Agent is already running for this PR: do not start another round; enqueue to be merged into the next main Agent cycle and reordered per the latest instruction (mid-flight input redirect).
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

  // Clear this PR's execution history (this PR only): delete remote records + clear the local list, and also clear the Agent conclusion result /
  // steps / error banner (including "stopped / failed" hints), to avoid stale feedback lingering after clearing. In-progress runs are unaffected
  // (they live in chatRunStore and are re-persisted on completion).
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

  // Cancel / retry are just two simple steps in the store model: cancel goes through IPC, retry calls handleRun
  const handleCancel = async (runId: string): Promise<void> => {
    try {
      await invoke('pragent:cancel', { runId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Delete a single finished run record (success / failed / cancelled): after deleting the remote record, optimistically remove it from the local list.
  // Deletes only that run, not touching the Agent session / ledger / badge (distinct from "clear").
  const handleDeleteRun = async (runId: string): Promise<void> => {
    if (!prLocalId) return;
    try {
      await invoke('pragent:deleteRun', { localId: prLocalId, runId });
      setRuns((prev) => prev.filter((r) => r.id !== runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Stop all in-progress tasks in this PR session: cancel every active run one by one (may be >1 with Agent parallel multi-select),
  // and abort the Agent orchestration (abort, preventing it from continuing subsequent steps after sub-tasks are cancelled).
  const handleStopAll = (): void => {
    for (const r of myActiveRuns) void handleCancel(r.runId);
    if (agentRunningHere && prLocalId) void invoke('agent:stop', { localId: prLocalId });
  };
  const handleRetry = (run: ReviewRun): void => {
    // Retry reuses the original run's single-commit scope (if any), ensuring the rerun stays limited to the same commit.
    void handleRun(run.tool, run.question, undefined, undefined, run.scope);
  };

  /**
   * Turns an AI finding body into the draft's initial body: first stripFindingMarker removes the
   * trailing [file:...] marker, then normalizes inline HTML tags in pr-agent's GFM into markdown (the draft editor is
   * plain text, so bare `<code>`/`<br>` would leak through), and finally adds the `[AI suggestion]` prefix — so the remote reviewer
   * knows this comment came from pr-agent
   */
  const buildDraftBodyFromFinding = (body: string): string =>
    `${t('chatPane.aiSuggestionPrefix')} ${htmlInlineToMarkdown(stripFindingMarker(body))}`;

  /**
   * Handler for clicking the "Edit" button on a ChatPane finding card:
   * - Already has an associated draft → directly onJumpToDraftEditor, DiffView opens it
   * - No associated draft → lazily create a pending one + onJumpToDraftEditor
   * - Associated draft is rejected → update back to pending (undo rejection) + jump
   */
  const handleJumpToDraft = async (finding: Finding, run: ReviewRun): Promise<void> => {
    if (!pr) return;
    if (!finding.anchor || typeof finding.anchor.startLine !== 'number') {
      return; // No anchor line number → cannot become inline; the button should not appear, fallback
    }
    const startLine = finding.anchor.startLine;
    const endLine = finding.anchor.endLine ?? startLine;
    const existing = (drafts ?? []).find(
      (d) =>
        d.source !== undefined && d.source.runId === run.id && d.source.findingId === finding.id,
    );
    try {
      if (!existing) {
        // Lazy create: copy the body from the finding as initial content; side defaults to 'new' (head-side inline comment convention)
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
        // Undo the reject decision → back to pending, letting the user edit again
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

  // Click a finding anchor: only navigate to the corresponding Diff line (does not create/open a draft), for quickly checking context
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
