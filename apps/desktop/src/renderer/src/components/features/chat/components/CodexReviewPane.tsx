import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CODEX_QUESTION_LIMIT,
  type CodexReviewReadiness,
  type Finding,
  type LocalPrStatus,
  type ReviewerStatus,
  type ReviewRun,
} from '@meebox/shared';
import { invoke } from '../../../../api';
import { useChatRunStore } from '../../../../stores/chat-run-store';
import { AutoReviewIcon, ChatIcon, PaneLoading, SendIcon, StopIcon } from '../../../common';
import { CodexModelPicker } from './CodexModelPicker';
import { ChatCommandButton, ChatCommandSuggestions } from './ChatCommands';
import { ChatEmptyCommands } from './ChatEmpty';
import { ResizableChatInput } from './ResizableChatInput';
import { RunResultView } from './RunResultView';
import { QueuedView } from './QueuedView';
import { RunningView } from './RunningView';
import { Bullet } from './shared';
import { resolveCodexModel } from '../utils/codex-models';
import { CODEX_COMMANDS } from '../commands';
import { useChatCommands } from '../hooks/useChatCommands';
import { parseCodexCommand } from '../utils/parse-command';
import { scrollToResult } from '../utils/scroll-to-result';

type Props = Pick<
  ComponentProps<typeof RunResultView>,
  'drafts' | 'closures' | 'onJumpToDraft' | 'onRejectFinding' | 'onNavigateToFinding'
> & {
  localId?: string;
  collapsed?: boolean;
  visible: boolean;
  inputHeight: number | null;
  onInputHeightChange: (height: number) => void;
  headSha?: string;
  baseSha?: string;
  status: CodexReviewReadiness;
  model: string;
  onModelChange: (model: string) => void;
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  reviewStatuses?: readonly ReviewerStatus[];
  onRecheck: () => void;
};

export function CodexReviewPane({
  localId,
  collapsed,
  visible,
  inputHeight,
  onInputHeightChange,
  headSha,
  baseSha,
  status,
  model,
  onModelChange,
  onSetReviewStatus,
  reviewStatuses,
  onRecheck,
  ...resultProps
}: Props) {
  const { t } = useTranslation();
  const { active, waiting, codexProgressByRunId } = useChatRunStore();
  const running = active.find((run) => run.prLocalId === localId && run.engine === 'codex');
  const queued = waiting.find((run) => run.prLocalId === localId && run.engine === 'codex');
  const busy = running ?? queued;
  const [runs, setRuns] = useState<ReviewRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelError, setModelError] = useState(false);
  const [question, setQuestion] = useState('');
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reference, setReference] = useState<{ run: ReviewRun; finding: Finding } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const runningId = running?.runId;
  const latestRunId = runs?.[0]?.id;
  const activeReference =
    reference?.run.headSha === headSha && reference?.run.baseSha === baseSha ? reference : null;
  const selectedModel = resolveCodexModel(models, model);
  const selectedModelId = selectedModel?.id;
  const canSubmit = !!localId && !busy && !submitting && status === 'ready' && !loadingModels;
  const availableCommands = CODEX_COMMANDS.filter((command) => {
    if (command.kind !== 'review-action') return status === 'ready';
    const reviewStatus = command.reviewStatus === 'approved' ? 'approved' : 'needsWork';
    return !!onSetReviewStatus && (reviewStatuses?.includes(reviewStatus) ?? true);
  });
  const helpCommands = localId
    ? availableCommands
    : availableCommands.filter((command) => command.kind !== 'review-action');
  const inputDisabled = !localId || availableCommands.length === 0;
  const trimmedQuestion = question.trim();
  const parsed = trimmedQuestion ? parseCodexCommand(trimmedQuestion, availableCommands) : null;
  const canSend =
    !inputDisabled &&
    parsed !== null &&
    (parsed.kind === 'run' || parsed.kind === 'agentAsk' ? canSubmit : true);
  const changeQuestion = (value: string) => {
    setQuestion(value);
    setCommandError(null);
  };
  const commands = useChatCommands({
    input: question,
    onInputChange: changeQuestion,
    textareaRef: inputRef,
    commands: availableCommands,
    disabled: inputDisabled,
  });

  useEffect(() => {
    if (!visible || status !== 'ready') return;
    let live = true;
    setLoadingModels(true);
    setModelError(false);
    void invoke('codex:models', undefined).then(
      (items) => {
        if (!live) return;
        setModels(items);
        setLoadingModels(false);
      },
      () => {
        if (!live) return;
        setModelError(true);
        setLoadingModels(false);
      },
    );
    return () => {
      live = false;
    };
  }, [status, visible]);

  useEffect(() => {
    if (
      status === 'ready' &&
      !loadingModels &&
      !modelError &&
      selectedModelId &&
      selectedModelId !== model
    ) {
      onModelChange(selectedModelId);
    }
  }, [status, loadingModels, modelError, selectedModelId, model, onModelChange]);

  useEffect(() => {
    if (!localId) return;
    let live = true;
    void invoke('codex:listRuns', { localId }).then(
      (result) => {
        if (live) setRuns(result.filter((run) => run.id !== runningId));
      },
      (err: unknown) => {
        if (live) {
          setRuns([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [localId, runningId]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [latestRunId, runningId, queued?.runId]);

  const start = async (ask?: { question: string; reference?: ReviewRun['referencedFinding'] }) => {
    if (!localId || !canSubmit) return false;
    setError(null);
    setSubmitting(true);
    try {
      const result = ask
        ? await invoke('codex:ask', { localId, model: selectedModelId, ...ask })
        : await invoke('codex:review', { localId, model: selectedModelId });
      setRuns((prev) => [result, ...(prev ?? []).filter((run) => run.id !== result.id)]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onRecheck();
      return false;
    } finally {
      setSubmitting(false);
    }
  };
  const send = () => {
    if (!canSend || !parsed) return;
    if (parsed.kind === 'unknown') {
      setCommandError(
        t('chatPane.unknownCommand', {
          head: parsed.head,
          cmds: availableCommands.map((command) => command.label).join(' / '),
        }),
      );
      return;
    }
    if (parsed.kind === 'commandNoArgs') {
      setCommandError(t('chatPane.commandNoArgs', { cmd: parsed.cmd }));
      return;
    }
    if (parsed.kind === 'askNeedsQuestion') {
      setCommandError(t('chatPane.askNeedsQuestion'));
      return;
    }
    if (parsed.kind === 'reviewAction' && onSetReviewStatus) {
      changeQuestion('');
      onSetReviewStatus(parsed.status);
      return;
    }
    if (parsed.kind === 'run' && parsed.name === 'review') {
      changeQuestion('');
      void start().then((accepted) => {
        if (!accepted) setQuestion((current) => current || question);
      });
      return;
    }
    const text =
      parsed.kind === 'agentAsk' || (parsed.kind === 'run' && parsed.name === 'ask')
        ? parsed.question
        : undefined;
    if (!text) return;
    const ref = activeReference && {
      runId: activeReference.run.id,
      findingId: activeReference.finding.id,
    };
    changeQuestion('');
    setReference(null);
    void start({ question: text, reference: ref || undefined }).then((accepted) => {
      if (!accepted) {
        setQuestion((current) => current || question);
        setReference((current) => current ?? activeReference);
      }
    });
  };
  const remove = async (runId: string) => {
    if (!localId) return;
    try {
      const { ok } = await invoke('codex:deleteRun', { localId, runId });
      if (ok) setRuns((prev) => prev?.filter((run) => run.id !== runId) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const cancel = async (runId: string) => {
    try {
      if (localId) await invoke('codex:cancel', { localId, runId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="chat-pane-body" ref={bodyRef}>
        {localId && !runs && <PaneLoading />}
        {(!localId || (runs?.length === 0 && !busy && !submitting)) && (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <ChatIcon size={28} />
            </div>
            <div className="chat-empty-title chat-codex-empty-heading">
              <span>
                {t(localId ? 'chatPane.codex.emptyTitle' : 'chatPane.emptySelectPrTitle')}
              </span>
              <span className="badge-experimental">{t('settings.experimental')}</span>
            </div>
            {status === 'ready' && (
              <p className="chat-empty-sub">{t('chatPane.codex.emptyHint')}</p>
            )}
            {helpCommands.length > 0 && (
              <ChatEmptyCommands>
                {helpCommands.map((command) => (
                  <Bullet key={command.name}>
                    <code>
                      {command.label}
                      {command.name === 'ask' && ` <${t('chatPane.askArgQuestion')}>`}
                    </code>{' '}
                    {t(
                      command.name === 'ask'
                        ? 'chatPane.codex.bulletAsk'
                        : command.name === 'review'
                          ? 'chatPane.codex.bulletReview'
                          : command.descKey,
                    )}
                  </Bullet>
                ))}
              </ChatEmptyCommands>
            )}
            {(!localId || helpCommands.length > 0) && (
              <p className="chat-empty-foot muted">
                {t(localId ? 'chatPane.emptyFootWithPr' : 'chatPane.emptyFootNoPr')}
              </p>
            )}
          </div>
        )}
        {runs
          ?.slice()
          .reverse()
          .filter((run) => run.id !== runningId)
          .map((run, i, history) => {
            const current = run.headSha === headSha && run.baseSha === baseSha;
            return (
              <div key={run.id} data-run-id={run.id}>
                {run.status === 'succeeded' && !current && (
                  <p className="muted">{t('chatPane.codex.outdated')}</p>
                )}
                <RunResultView
                  onScrollToRun={(runId) => scrollToResult(bodyRef.current, runId)}
                  onScrollToFinding={(runId, findingId) =>
                    scrollToResult(bodyRef.current, runId, findingId)
                  }
                  {...resultProps}
                  run={run}
                  canRetry={
                    canSubmit && i === history.length - 1 && (run.tool === 'review' || current)
                  }
                  onRetry={() =>
                    void start(
                      run.tool === 'ask' && run.question
                        ? { question: run.question, reference: run.referencedFinding }
                        : undefined,
                    )
                  }
                  onDelete={(id) => void remove(id)}
                  onJumpToDraft={current ? resultProps.onJumpToDraft : undefined}
                  onNavigateToFinding={current ? resultProps.onNavigateToFinding : undefined}
                  onRejectFinding={current ? resultProps.onRejectFinding : undefined}
                  onReferenceFinding={
                    current && run.tool === 'review' && status === 'ready'
                      ? (finding) => {
                          setReference({ run, finding });
                          inputRef.current?.focus();
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        {running && (
          <RunningView
            tool={running.tool}
            question={running.question}
            runId={running.runId}
            engine="codex"
            lines={[]}
            codexProgress={codexProgressByRunId.get(running.runId)}
            model={null}
            startedAt={new Date(running.startedAt ?? running.enqueuedAt).getTime()}
          />
        )}
        {queued && (
          <QueuedView
            tool={queued.tool}
            question={queued.question}
            position={waiting.indexOf(queued) + 1}
            onCancel={() => void cancel(queued.runId)}
          />
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <form
        className="chat-pane-input chat-codex-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {status !== 'ready' && <span role="status">{t(`chatPane.codex.${status}`)}</span>}
        {activeReference && (
          <button
            type="button"
            className="chat-chip"
            title={t('chatPane.commentReference.clearTitle')}
            onClick={() => setReference(null)}
          >
            {activeReference.finding.title ??
              activeReference.finding.anchor?.path ??
              t('chatPane.codex.reference')}{' '}
            ×
          </button>
        )}
        <ChatCommandSuggestions menu={commands} />
        <ResizableChatInput
          textareaRef={inputRef}
          inputHeight={inputHeight}
          onInputHeightChange={onInputHeightChange}
          value={question}
          maxLength={CODEX_QUESTION_LIMIT}
          aria-label={t('chatPane.codex.ask')}
          placeholder={t('chatPane.codex.ask')}
          disabled={inputDisabled}
          onChange={(event) => changeQuestion(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (commands.handleCommandKeyDown(event)) return;
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        {commandError && (
          <div className="chat-input-error" role="alert">
            {commandError}
          </div>
        )}
        <div className="chat-codex-actions">
          <div className="chat-cmd-group">
            <ChatCommandButton menu={commands} />
            {localId && (
              <button
                type="button"
                className={`chat-cmd-trigger chat-agent-review-trigger${running?.tool === 'review' ? ' active' : ''}`}
                onClick={() => void start()}
                disabled={!canSubmit}
                title={t('chatPane.codex.start')}
                aria-label={t('chatPane.codex.start')}
              >
                <AutoReviewIcon />
              </button>
            )}
          </div>
          <div className="chat-pane-send-group chat-codex-send-group">
            {running && (
              <button
                type="button"
                className="chat-pane-send chat-pane-send-stop"
                onClick={() => void cancel(running.runId)}
                title={t('chatPane.stopTitle')}
                aria-label={t('chatPane.stopAria')}
              >
                <StopIcon />
              </button>
            )}
            {!collapsed && (
              <CodexModelPicker
                label={t('chatPane.codex.model')}
                options={status === 'ready' ? models : []}
                selected={selectedModel}
                loading={status === 'ready' && loadingModels}
                onSelect={onModelChange}
              />
            )}
            <button
              type="submit"
              className="chat-pane-send"
              disabled={!canSend}
              title={t('chatPane.codex.send')}
              aria-label={t('chatPane.codex.send')}
            >
              <SendIcon />
            </button>
          </div>
        </div>
        {modelError && <span role="status">{t('errors.EAG0007')}</span>}
      </form>
    </>
  );
}
