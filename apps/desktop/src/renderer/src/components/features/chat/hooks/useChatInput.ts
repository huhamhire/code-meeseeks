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
  /** PR is directly mergeable on the remote (mergeStatus.canMerge): when false, /merge does not appear in autocomplete/command menu, and mistyped input is also rejected. */
  canMerge?: boolean;
  /** /merge trigger: hand off to ChatPane to pop a second confirmation before actually merging. */
  onMerge?: () => void;
}

/**
 * Input bar state machine: input / `/` command parsing and submission / autocomplete overlay / history replay (shell-style Up/Down) / stop request.
 * Pure command-parsing logic in ../utils/parse-command; history stack in ../utils/chat-history. ChatInputBar only consumes the return value to render.
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
  canMerge = false,
  onMerge,
}: UseChatInputParams) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  // On PR switch, clear the error hint + leftover input (to avoid showing a stale error "unknown command" etc. across PRs)
  useEffect(() => {
    setParseError(null);
    setInput('');
  }, [pr?.localId]);
  const [cmdMenuOpen, setCmdMenuOpen] = useState(false);
  // Selected-item index of the autocomplete menu (the overlay shown when the textarea contains /)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  // Menu was already dismissed for a specific input value (Esc / inserted after selecting). Invalidated as soon as input changes
  // → the menu naturally reappears as the user keeps typing, but does not immediately re-pop right after selecting / Esc
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // History replay: stack from newest to oldest; historyIdx indicates the position currently being browsed (-1 = not in browsing state)
  const [history, setHistory] = useState<string[]>(() => loadChatHistory());
  const [historyIdx, setHistoryIdx] = useState(-1);
  // The content the user was editing before entering history browsing; restored when pressing Down back to the bottom, mimicking shell behavior
  const draftBeforeHistoryRef = useRef<string>('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);

  // Queue model: disable input only when !pr / pr-agent not ready. activeRun / busyOnOtherPr
  // no longer block new submissions (queued by main). running decides whether to render the stop button: besides an active tool run,
  // the Agent's own execution phase (thinking / orchestration, with no tool run occupied) also counts as "running", so it can be cancelled anytime.
  const running = runningTool !== null || agentRunningHere;
  // Also disable when the LLM is not configured: even if the pr-agent runtime is ready, without a model no call can be made
  const disabled = !pr || !prAgent.available || !llmConfigured;
  // After the stop button is clicked, the state only changes once main returns queueChanged; a second click during this interval
  // should be a no-op, to avoid repeatedly spamming abort
  const [stopRequested, setStopRequested] = useState(false);
  // When running → false (the run has finished), reset stopRequested so the next run can be cancelled again
  useEffect(() => {
    if (!running) setStopRequested(false);
  }, [running]);
  const trimmed = input.trim();
  // Visible command set: hide /merge when the PR is not directly mergeable (don't hint an unavailable action in autocomplete / command menu).
  const visibleCommands = canMerge ? COMMANDS : COMMANDS.filter((c) => c.kind !== 'pr-action');
  // Starts with `/` + command name not fully typed yet (no space) → show candidates; hidden if already dismissed for the current input
  const showAutocomplete =
    !disabled && dismissedFor !== input && input.startsWith('/') && !input.includes(' ');
  const filtered = showAutocomplete
    ? visibleCommands.filter((c) => c.label.startsWith(input.split(' ')[0] ?? ''))
    : [];

  // Reset the selected item to the first when input changes (the candidate set changed)
  useEffect(() => {
    setAutocompleteIdx(0);
  }, [input]);

  // Popup menu triggered by the `/` command button: closes on outside click / Esc / selecting a command
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
    // Close the autocomplete menu immediately after selecting (insertAs may be "/describe" with no space, otherwise it would keep it propped open).
    // dismissedFor is bound to the current input value; as the user keeps typing and input changes, the menu reopens
    setDismissedFor(cmd.insertAs);
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(cmd.insertAs.length, cmd.insertAs.length);
      });
    }
  };

  // Shared by the successful-submit path: write the history stack + exit browsing state + clear input
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
        if (!onSetReviewStatus) return; // No callback wired → just ignore (protective)
        pushHistoryAndReset();
        onSetReviewStatus(parsed.status);
        return;
      case 'mergeAction':
        if (!onMerge) return; // No callback wired → just ignore (protective)
        // canMerge gate: reject and hint when not directly mergeable (the input no longer autocompletes /merge; this is the fallback for manual typing).
        if (!canMerge) {
          setParseError(t('chatPane.notMergeable'));
          return;
        }
        pushHistoryAndReset();
        onMerge(); // Hand off to ChatPane to pop confirmation before actually merging
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

  // History replay helper: set textarea content by idx; idx = -1 means exit browsing state, restore draft
  const applyHistoryIdx = (nextIdx: number): void => {
    setHistoryIdx(nextIdx);
    setInput(nextIdx < 0 ? draftBeforeHistoryRef.current : (history[nextIdx] ?? ''));
    // Move the cursor to the end so the next Up/Down behavior is predictable
    const el = textareaRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    }
  };

  // Decide whether Up/Down should trigger history replay: the textarea cursor must be at the first-line / last-line edge,
  // otherwise let Up/Down do native cursor movement (in multi-line editing, in-line navigation must not be hijacked)
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
    // During IME composing: intercept no shortcuts, hand off to the IME
    if (e.nativeEvent.isComposing) return;

    // When the autocomplete menu is open: intercept Up/Down/Enter/Tab/Esc for menu navigation, to avoid falling through to the textarea
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

    // History replay: when the menu is closed, Up/Down on an edge line → page through history. Middle lines let native cursor movement take over
    if (e.key === 'ArrowUp' && history.length > 0 && atFirstLine()) {
      e.preventDefault();
      if (historyIdx < 0) {
        // First entering browsing state: save the current editing content as draft, so Down can restore it back at the bottom
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
  };
}
