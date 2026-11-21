import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CODEX_QUESTION_LIMIT,
  type CodexReviewReadiness,
  type Finding,
  type LocalPrStatus,
  type ReviewerStatus,
  type ReviewRun,
  type StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../../../../api';
import { useChatRunStore } from '../../../../stores/chat-run-store';
import { AutoReviewIcon, ChatIcon, PaneLoading, SendIcon, StopIcon } from '../../../common';
import { CodexModelPicker } from './CodexModelPicker';
import { ChatCommandButton, ChatCommandSuggestions } from './ChatCommands';
import { ChatEmptyCommands } from './ChatEmpty';
import { CommitDividerList } from './CommitDivider';
import { ResizableChatInput } from './ResizableChatInput';
import { RunResultView } from './RunResultView';
import { QueuedView } from './QueuedView';
import { RunningView } from './RunningView';
import { Bullet } from './shared';
import { resolveCodexModel } from '../utils/codex-models';
import { CODEX_COMMANDS } from '../commands';
import { useChatCommands } from '../hooks/useChatCommands';
import { useCodexModelCatalog } from '../hooks/useCodexModelCatalog';
import { parseCodexCommand } from '../utils/parse-command';
import { scrollToResult } from '../utils/scroll-to-result';
import { computeCommitDividers, type CommitTimelineEntry } from '../utils/commit-dividers';

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
  headChanges?: StoredPullRequest['headChanges'];
  commitMessages?: ReadonlyMap<string, string>;
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
  headChanges,
  commitMessages,
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
  const { models, loading: loadingModels, error: modelError } = useCodexModelCatalog(
    visible && status === 'ready',
  );
  const [question, setQuestion] = useState('');
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reference, setReference] = useState<{ run: ReviewRun; finding: Finding } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const runningId = running?.runId;
  const history = (runs ?? [])
    .slice()
    .reverse()
    .filter((run) => run.id !== runningId);
  const timeline: CommitTimelineEntry[] = history.map((run) => ({
    key: run.id,
    sortTime: Date.parse(run.startedAt),
    headSha: run.headSha,
    completedReview: run.tool === 'review' && run.status === 'succeeded',
  }));
  if (running)
    timeline.push({
      key: running.runId,
      sortTime: Date.parse(running.startedAt ?? running.enqueuedAt),
      headSha: running.headSha,
    });
  const commitDividers = computeCommitDividers(timeline, headSha, headChanges);
  const latestRunId = runs?.[0]?.id;
  const activeReference =
    reference?.run.headSha === headSha && reference?.run.baseSha === baseSha ? reference : null;
  const selectedModel = resolveCodexModel(models, model);
  const selectedModelId = selectedModel?.id;
  const canSubmit =
    !!localId && !busy && !submitting && status === 'ready' && (!loadingModels || models.length > 0);
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
  const latestHeadChangeAt = headChanges?.at(-1)?.at;
  useEffect(() => {
    const body = bodyRef.current;
    if (
      latestHeadChangeAt &&
      body &&
      body.scrollHeight - body.scrollTop - body.clientHeight <= 64
    ) {
      body.scrollTop = body.scrollHeight;
    }
  }, [latestHeadChangeAt]);

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
        {history.map((run, i) => {
          const current = run.headSha === headSha && run.baseSha === baseSha;
          return (
            <div key={run.id}>
              <CommitDividerList
                shas={commitDividers.before.get(run.id)}
                messages={commitMessages}
              />
              <div data-run-id={run.id}>
                <RunResultView
                  onScrollToRun={(runId) => scrollToResult(bodyRef.current, runId)}
                  onScrollToFinding={(runId, findingId) =>
                    scrollToResult(bodyRef.current, runId, findingId)
                  }
                  {...resultProps}
                  run={run}
                  stale={!current}
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
                  onNavigateToFinding={resultProps.onNavigateToFinding}
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
            </div>
          );
        })}
        {running && (
          <>
            <CommitDividerList
              shas={commitDividers.before.get(running.runId)}
              messages={commitMessages}
            />
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
          </>
        )}
        <CommitDividerList shas={commitDividers.bottom} messages={commitMessages} />
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
                loading={status === 'ready' && loadingModels && models.length === 0}
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
        {modelError && !models.length && <span role="status">{t('errors.EAG0007')}</span>}
      </form>
    </>
  );
}
