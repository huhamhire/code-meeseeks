import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PrAgentStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import {
  AutoReviewIcon,
  CommitIcon,
  EyeOffIcon,
  FileTreeIcon,
  SendIcon,
  StopIcon,
} from '../../../common';
import { useChatInput } from '../hooks/useChatInput';
import { useTextareaAutosizeDrag } from '../hooks/useTextareaAutosizeDrag';

interface ChatInputBarProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  /** Whether the LLM is configured; when not, the input is disabled (even if the pr-agent runtime is ready it cannot be invoked) */
  llmConfigured: boolean;
  /**
   * The active run tool on this PR; when non-null, an extra stop button is rendered beside the send button.
   * Under the queue model the input is never disabled because of this (new submissions enter the queue).
   */
  runningTool: ReviewRunTool | null;
  onRun: (tool: ReviewRunTool, question?: string) => void;
  /** Natural-language input without a '/' prefix → handed to the free-planning Agent (conversation is delegation, see design "conversation as Agent"). */
  onAgentAsk: (question: string) => void;
  /**
   * Terminates the current active run. Only meaningful when runningTool is non-null; ChatPane has already bound the corresponding runId.
   * The stop button shares a slot with send: when runningTool is set, a click triggers this callback instead of onRun
   */
  onCancel?: () => void;
  /** review decision triggered by the /approve /needswork commands, shares prs:setLocalStatus with the PR header buttons */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /** The PR can be merged directly on the remote (mergeStatus.canMerge): decides whether /merge appears in the command menu / completion. */
  canMerge: boolean;
  /** Triggered by the /merge command (actually merges after a confirmation dialog, shares prs:merge with the PR header merge button). */
  onMerge?: () => void;
  /** Whether the Agent is running on the current PR: decides the icon button highlight + running text + disabling re-invocation (an Agent running on another PR does not disable this PR). */
  agentRunningHere: boolean;
  /** Triggers the one-click auto-review micro-flow (describe→review→conditional follow-up ask→summary). */
  onAgentReview: () => void;
  /**
   * Current Diff selection line count; null = no selection (the selection badge is not rendered). The badge sits to the
   * right of AutoReview, hinting "N lines selected", and carries the selected code into the question as implicit context on send.
   */
  selectionLineCount: number | null;
  /** Selection ignored state: when true this message carries no selection reference (badge greyed out + eye-slash). */
  selectionIgnored: boolean;
  /** Click the selection badge → toggle the ignored state. */
  onToggleSelection: () => void;
  /** Re-review reference chip: shows "re-review <file:line>" + clear when a finding is referenced; null = not rendered. */
  referenceChip?: { label: string; onClear: () => void } | null;
  /**
   * Single-commit scope chip: follows the commit selected in the Diff view, showing "short SHA · subject". Shown whenever there is
   * a selection, click to **toggle enable/disable** (disabling does not remove the chip, this session's commands revert to the whole
   * PR; disabled state greyed out + eye-slash) — the selected state originates from the view and can be disabled manually.
   */
  commitScopeChip?: { label: string; disabled: boolean; onToggle: () => void } | null;
}

/**
 * Input bar: textarea + command button + autocomplete triggered by `/`. State machine (input / command
 * parsing / completion / history replay / stop) see [useChatInput](../hooks/useChatInput.ts); the pure
 * command-parsing logic is in ../utils/parse-command.
 *
 * Submit semantics: empty does not submit; `/describe` `/review` etc. trigger the corresponding tool;
 * `/ask <text>` triggers ask; unknown `/xxx` errors; not starting with `/` = natural language delegated
 * to the free-planning Agent. Shift+Enter for a newline, Enter to submit.
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
  canMerge,
  onMerge,
  agentRunningHere,
  onAgentReview,
  selectionLineCount,
  selectionIgnored,
  onToggleSelection,
  referenceChip,
  commitScopeChip,
}: ChatInputBarProps) {
  const { t } = useTranslation();
  const {
    input,
    setInput,
    parseError,
    disabled,
    running,
    stopRequested,
    requestStop,
    showAutocomplete,
    filtered,
    visibleCommands,
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
  } = useChatInput({
    pr,
    prAgent,
    llmConfigured,
    runningTool,
    agentRunningHere,
    onRun,
    onAgentAsk,
    onCancel,
    onSetReviewStatus,
    canMerge,
    onMerge,
  });
  const { textareaHeightPx, handleTextareaResizeStart } = useTextareaAutosizeDrag(textareaRef);

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
                    // Prevent the blur handler from collapsing the menu after the textarea loses focus
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
        {/* Top-edge drag handle: drag up → textarea height increases, consistent with the visual expansion direction */}
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
                {visibleCommands.map((c, i) => {
                  const prev = visibleCommands[i - 1];
                  // Insert a divider at the pragent → review-action boundary
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
          {/* Auto-review: icon button right beside the `/` command trigger. Appears only when pr-agent is ready;
            disabled when the LLM is not configured / a review on this PR is in progress (a review running on another
            PR does not disable it — concurrency / queueing allowed). Stopping is handled uniformly by the stop button
            in the send area (cancelling the in-progress subtask terminates the flow); no separate Agent stop button is
            provided, avoiding two semantically overlapping stop entry points. */}
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
          {/* Diff selection badge: shows "N lines selected" after a vertical divider. Click to toggle the ignored
              state (eye-slash + greyed out) — when ignored this message carries no selection reference. The selected
              code is sent as implicit context with the question and does not enter the conversation bubble. */}
          {selectionLineCount !== null && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <button
                type="button"
                className={`chat-selection-chip${selectionIgnored ? ' ignored' : ''}`}
                onClick={onToggleSelection}
                title={
                  selectionIgnored
                    ? t('chatPane.selection.ignoredTitle')
                    : t('chatPane.selection.attachedTitle')
                }
              >
                {selectionIgnored ? <EyeOffIcon /> : <FileTreeIcon />}
                <span>{t('chatPane.selection.linesSelected', { lines: selectionLineCount })}</span>
              </button>
            </>
          )}
          {/* Re-review reference chip: shows "re-review <file:line>" when a review/improve finding is referenced, click ✕ to clear the reference.
              On send this /ask carries the finding reference into re-review mode (produces a verdict + adopt/close actions). */}
          {referenceChip && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <span className="chat-selection-chip chat-reference-chip" title={referenceChip.label}>
                <FileTreeIcon />
                <span>{referenceChip.label}</span>
                <button
                  type="button"
                  className="chat-reference-chip-clear"
                  onClick={referenceChip.onClear}
                  title={t('chatPane.reference.clearTitle')}
                  aria-label={t('chatPane.reference.clearTitle')}
                >
                  ✕
                </button>
              </span>
            </>
          )}
          {/* Single-commit scope chip: follows the commit selected in the view, showing "short SHA · subject". Click to toggle enable/disable (without removing) —
              when enabled the commands are scoped to that commit (parent..sha), when disabled they revert to the whole PR, greyed out + eye-slash. */}
          {commitScopeChip && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <button
                type="button"
                className={`chat-selection-chip${commitScopeChip.disabled ? ' ignored' : ''}`}
                onClick={commitScopeChip.onToggle}
                title={
                  commitScopeChip.disabled
                    ? t('chatPane.scopeDisabledTitle')
                    : t('chatPane.scopeActiveTitle')
                }
              >
                {commitScopeChip.disabled ? <EyeOffIcon /> : <CommitIcon size={14} />}
                <span>{commitScopeChip.label}</span>
              </button>
            </>
          )}
        </div>
        {/* Under the queue model send is always present (new submissions enter the queue); when this PR is active, stop sits right to the left of send.
            Wrapped in a group to prevent input-row's space-between from pushing stop to the center */}
        <div className="chat-pane-send-group">
          {running && onCancel && (
            <button
              type="button"
              className="chat-pane-send chat-pane-send-stop"
              onClick={requestStop}
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
            disabled={disabled || !input.trim()}
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
