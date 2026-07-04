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
  /** Keep the component mounted when collapsed (preserves the in-progress run timer / runProgress
      subscription); hide with CSS only. On expand the user sees the current live state */
  collapsed?: boolean;
  /**
   * Jump to the Diff view to edit the draft for a finding (M4). Parent (MainPane)
   * implements: switch tab='diff' + DiffView scroll/highlight/open edit zone + lazily create draft
   * if it doesn't exist yet. anchor is passed directly via finding.anchor.
   */
  onJumpToDraftEditor?: (target: {
    runId: string;
    findingId: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
  /** PR review verdict triggered by the /approve /needswork commands; wired to prs:setLocalStatus by MainPane */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /** Merge triggered by the /merge command (called after the confirm dialog, shares prs:merge with the PR header merge button); only available when canMerge. */
  onMerge?: () => void;
  /**
   * Click a finding's file-line anchor → only jump to the corresponding Diff line (scroll+highlight, no edit mode).
   * Difference from onJumpToDraftEditor: no runId/findingId, does not create / open a draft.
   */
  onNavigateToAnchor?: (anchor: { path: string; startLine: number; endLine: number }) => void;
  /**
   * Model name of the currently active LLM profile — shown in the RunningView meta chip.
   * null = no active profile / still loading, UI does not show the model chip
   */
  currentLlmModel?: string | null;
  /**
   * Whether a usable LLM is configured (a profile matching active_id exists). When false, even if the
   * pr-agent runtime is ready, no call can be started — the empty state / input bar shows a "needs config" hint and is disabled.
   */
  llmConfigured?: boolean;
  /** Open the settings panel (used by the "Go to settings" button in the LLM-not-configured hint) */
  onOpenSettings?: () => void;
  /**
   * The single-commit scope currently selected in the Diff view (null when none / root commit): serves as the **implicit scope**
   * for this PR's chat commands — directly typed /describe /review /improve /ask are automatically limited to that commit (the input bar shows a dismissible scope chip). After
   * dismissing that chip, this session no longer follows the view scope (until switching to another commit). The auto review micro-flow is unaffected and always operates on the full PR.
   */
  viewCommitScope?: ReviewRunCommitScope | null;
}

/**
 * pr-agent invocation panel (M3-D1).
 * - Header: two action buttons (/describe /review), disabled and pointing to Settings when pr-agent is unavailable
 * - Running: live-scrolling stdout (streamed from main via pragent:runProgress)
 * - After running: shows the latest ReviewRun's findings list (markdown body + optional anchor)
 *
 * This component is the "container": state and lifecycle go to useChatSession, business actions to useChatActions, timeline merging to
 * useChatTimeline; presentation and utility methods are split into ./components and ./utils. Here we only do layout orchestration and a bit of pure UI state.
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
    // Dragging the right edge = shrink chat (dx away from the left is positive)
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

  // Global active runs + live stdout cache. The store is fed by main's 'pragent:activeChanged'
  // / 'pragent:runProgress' events and survives PR switches, so this is read-only here, not maintained in this component
  const { active, waiting, linesByRunId } = useChatRunStore();
  // Concurrency model: active is a list of concurrently running runs. This PR's running runs may be >1 (user fires multiple
  // tools at the same PR); other PRs' concurrency count feeds the "running elsewhere" hint.
  const myActiveRuns = active.filter((a) => a.prLocalId === pr?.localId);
  const hasMyActive = myActiveRuns.length > 0;
  // This PR's queued tasks (FIFO, earlier ones run first), shown as "queued" cards at the end of the chat
  const myWaiting = waiting.filter((w) => w.prLocalId === pr?.localId);
  const myActiveIds = myActiveRuns.map((a) => a.runId);

  // M4 draft pool: fetch this PR's drafts from the main process, associated with findings via the source field
  const drafts = useDraftsForPr(prLocalId);
  // Re-review closure-relation pool (read-only): when a re-review /ask verdict is replace/drop, the backend automatically closes the original finding (see asks-step →
  // closeFinding) and broadcasts it; here we look up by (runId,findingId) and mark it on FindingCard with a read-only chip "superseded/closed by re-review".
  const closures = useFindingClosuresForPr(prLocalId) ?? [];

  // Re-review reference state: clicking a finding's "reference" → only attaches to the input bar (chip); does not auto-fill the question, the user types it. The reference is carried on send.
  const [refFinding, setRefFinding] = useState<{ finding: Finding; run: ReviewRun } | null>(null);
  // "Detached from view scope" state: after the user ✕'s the scope chip, this session's commands no longer follow the commit selected in the Diff view (until switching to another commit
  // or switching PR resets it). Follows the view scope by default.
  const [scopeDetached, setScopeDetached] = useState(false);
  // On PR switch, clear the reference state and reset the detached state to avoid cross-PR residue.
  useEffect(() => {
    setRefFinding(null);
    setScopeDetached(false);
  }, [prLocalId]);
  // On switching to another commit (or clearing the view scope), reset the detached state: the newly selected commit becomes the implicit scope again.
  useEffect(() => {
    setScopeDetached(false);
  }, [viewCommitScope?.sha]);
  const onReferenceFinding = (finding: Finding, run: ReviewRun): void => {
    setRefFinding({ finding, run });
  };

  // Diff selection (belonging to the current PR): used for the input bar's "N lines selected" badge + carrying the selected code as implicit context into a question.
  const { selection: diffSelection, ignored: selectionIgnored } = useDiffSelection(prLocalId);
  // When not ignored, format the selection into a reference string; shared by /ask and natural-language questions. Ignored / no selection → undefined (this message carries no reference).
  const referencedContext =
    diffSelection && !selectionIgnored ? formatReferencedContext(diffSelection) : undefined;

  // The effective scope for this PR's chat commands: follows the commit selected in the Diff view, unless the user has detached (scopeDetached).
  // Only one scope may be in effect at a time — when a Diff selection exists it takes precedence (finer-grained), the commit scope is suspended and its chip
  // is hidden too (see commitScopeChip), auto-restored after the selection is cleared.
  const effectiveScope = diffSelection || scopeDetached ? null : (viewCommitScope ?? null);

  // Session state + lifecycle (reload on PR switch / streaming steps / pagination / auto-scroll)
  const session = useChatSession(prLocalId, myActiveIds);

  // When switching away and back, the running run has been persisted (status=running) → listRuns reads it into runs,
  // while it is also a live running run, causing duplicate rendering (a history card + a RunningView). Here we
  // remove all running runs from the history list; running ones are shown solely by the RunningView below.
  const myActiveIdSet = new Set(myActiveIds);
  const visibleRuns = hasMyActive
    ? session.runs.filter((r) => !myActiveIdSet.has(r.id))
    : session.runs;

  // Business action set (trigger tool / auto review / conversation / cancel / clear / finding→draft)
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

  // Send a re-review /ask: carries the referenced finding's structured reference + body context, going through the /ask direct tool (produces a verdict +
  // adopt/close action); clears the reference state after sending.
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

  // Send an /ask limited to the currently viewed commit: carries the effective scope along with the question (limited to the parent..sha diff).
  const sendScopedAsk = (q: string): void => {
    if (!effectiveScope) return;
    void actions.handleRun('ask', q, undefined, undefined, effectiveScope);
  };

  // History timeline merge + live timing anchor for "thinking"
  const { timeline, thinkingSince } = useChatTimeline({
    visibleRuns,
    myActiveRuns,
    agentSteps: session.agentSteps,
    messages: session.messages,
    runningPrs: actions.runningPrs,
    prLocalId,
  });

  // Pure UI state: rule preview modal / clear confirm modal / merge confirm modal
  const [showRulePreview, setShowRulePreview] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showMergeConfirm, setShowMergeConfirm] = useState(false);

  const { runs, error, loadingSession, matchedRules, bodyRef, hasMoreOlder, loadingOlder } = session;

  // Re-review card ↔ original finding card cross-link: scroll to and briefly highlight. The flash class differs by target: run cards use chat-run-flash
  // (fading background, visible on the run card's transparent base); finding cards use chat-finding-flash (an overlay highlight ring — finding cards have
  // a solid $bg-elev base, so a fading background would be washed out and the flash unnoticeable).
  const flash = (el: Element, cls: 'chat-run-flash' | 'chat-finding-flash'): void => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 1600);
  };
  const scrollToRun = (runId: string): void => {
    const el = bodyRef.current?.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
    if (el) flash(el, 'chat-run-flash');
  };
  // Clicking the reference badge at the top of a re-review card: precisely locate and flash-highlight the referenced finding card within the original run (if the card isn't found —
  // e.g. paged out / collapsed — fall back to highlighting the whole run, giving at least positional feedback).
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
        {/* Runtime strategy chip removed: users don't care about deployment details, and the status bar already has a PR Agent version chip */}
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

      {/* Chip for rules matched by the current PR: not shown when rules.dir is unconfigured / globally disabled / no match.
          Click to expand the body preview so the user can confirm which rule will constrain this review */}
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

      {/* The planning Agent's plan panel: refreshes live from agent:planUpdated while running and re-orders with new input; empty plans are not rendered.
          Placed below the header and above the scroll area, always visible. */}
      <PlanPanel todo={session.todo} />

      <div className="chat-pane-body" ref={bodyRef}>
        {/* Overlay a delayed loading indicator during the initial session fetch (shown only after >150ms), masking the "clear → content pop-in" jitter;
            only fall through to the real empty state below once loading completes, avoiding an empty PR falsely showing loading. */}
        {loadingSession && <PaneLoading />}
        {/* The usage hint shows only when there is "no session content at all": as soon as there's a user input bubble / run / step / final result,
            or the Agent is running / has queued tasks, it hides, to avoid the hint lingering after input. */}
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
        {/* There are still older runs not fetched locally → show a loading hint at the top. Keep scrolling up to auto-cursor-fetch a page */}
        {(hasMoreOlder || loadingOlder) && (
          <div className="chat-run-more-hint muted" role="status">
            {loadingOlder ? t('common.loading') : t('chatPane.scrollUpForOlder')}
          </div>
        )}
        {/* History runs stacked in ascending time order, each an independent card (maintaining its own raw stdout collapse state).
            Initially only the latest RUNS_PAGE_SIZE are fetched; after scrolling up to the top, fetch an earlier batch by cursor */}
        {timeline.map((entry, i) =>
          entry.run ? (
            // data-run-id: for re-review card ↔ original finding card cross-link scroll targeting (scrollToRun).
            <div key={entry.key} data-run-id={entry.run.id}>
              <RunResultView
                run={entry.run}
                onRetry={actions.handleRetry}
                onDelete={actions.handleDeleteRun}
                // Only in the single case of "the last run in the timeline + nothing running" can a failed / cancelled run
                // be retried; once the user has started a new action (whether succeeded or running) → old failures no longer show retry,
                // avoiding a back-click re-queue that would disrupt conversation order
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
            // Running: progress bar + live stdout stream, interleaved into the timeline by start time (startedAt is null when enqueued,
            // set when it starts, falling back to enqueuedAt). Not rendered when prAgent is not ready.
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
        {/* This PR's queued tasks: placed after running ones, each cancellable individually. The position uses the **global** queue order (the queue is shared across PRs,
            otherwise every PR showing "position 1" would be misleading) — the runId's index in the global waiting array +1. */}
        {myWaiting.map((w) => (
          <QueuedView
            key={w.runId}
            tool={w.tool}
            question={w.question}
            position={waiting.findIndex((x) => x.runId === w.runId) + 1}
            onCancel={() => void actions.handleCancel(w.runId)}
          />
        ))}
        {/* Procedural tracking (Claude Code-like): completed thinking steps are already interleaved into the timeline above by time (AgentStepRow),
            here we only add a live "thinking" indicator when the Agent's own LLM is reasoning (no pr-agent tool run occupying / queued) —
            waiting on a tool call doesn't count as thinking. The timer is anchored to "the end of the most recent activity" (the latest of run start / last step / last completed
            run's end time) rather than component mount — switching PR and back doesn't reset it (runningPrs and run history persist). */}
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
        // Under the queue model input is always enabled (new submissions enter the queue / execute concurrently); runningTool only decides whether to additionally
        // render the stop button (clickable to terminate when this PR has a running run). With multiple concurrent, stop terminates the most recent one.
        runningTool={myActiveRuns[myActiveRuns.length - 1]?.tool ?? null}
        // referencedContext carries the selection reference only for /ask and natural-language questions (not describe/review).
        // When a finding is referenced: this message is forced through re-review /ask (carrying the finding reference + body context), clearing the reference after sending.
        onRun={(tool, q) => {
          if (tool === 'ask' && refFinding) {
            sendReferencedAsk(q ?? '');
            return;
          }
          if (tool === 'ask' && effectiveScope) {
            sendScopedAsk(q ?? '');
            return;
          }
          // describe/review/improve also follow the view commit scope (effectiveScope); when no scope, the full PR.
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
          // When a commit is selected in the view, natural-language questions also go through /ask scoped to that commit (limited to that commit's diff).
          if (effectiveScope) {
            sendScopedAsk(q);
            return;
          }
          void actions.handleAgentAsk(q, referencedContext);
        }}
        onCancel={hasMyActive || agentRunningHere ? actions.handleStopAll : undefined}
        onSetReviewStatus={onSetReviewStatus}
        // /merge: appears in the command menu only when the remote can be merged directly; triggering first shows a confirm dialog, merging only after confirmation.
        canMerge={pr?.mergeStatus?.canMerge ?? false}
        onMerge={onMerge ? () => setShowMergeConfirm(true) : undefined}
        // One-click auto review: icon button placed to the right of the `/` command trigger. runningHere=running on the current PR (highlight / running text +
        // disable re-triggering); another PR running does not disable this PR's trigger (can run concurrently / queue).
        agentRunningHere={agentRunningHere}
        onAgentReview={() => void actions.handleAgentReview()}
        // Diff selection badge: N lines selected / click to toggle ignore; null when no selection (not rendered).
        selectionLineCount={diffSelection?.lineCount ?? null}
        selectionIgnored={selectionIgnored}
        onToggleSelection={() => selectionStore.toggleIgnored()}
        // Re-review reference: chip (directly shows the reference location <file:line> + clear); attached when clicking a finding's "reference", does not auto-fill the question.
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
        // Single-commit scope chip: shown when a commit is selected in the view (the selected state comes from the view); click to toggle enabled/disabled —
        // when disabled (scopeDetached) commands revert to the full PR and the chip greys out; switching to another commit or switching PR resets it to enabled.
        // Only one scope at a time: when a Diff selection exists it yields to the selection chip (hides this chip), auto-restored after the selection is cleared.
        commitScopeChip={
          viewCommitScope && !diffSelection
            ? {
                // Show only the short hash, without the subject (to avoid overly long chip content); the subject is already visible in the Diff view and result-card badge.
                label: viewCommitScope.abbreviatedSha,
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
