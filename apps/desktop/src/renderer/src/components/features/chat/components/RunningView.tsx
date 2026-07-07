import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewRunCommitScope, ReviewRunTool } from '@meebox/shared';
import { CommitIcon } from '../../../common';
import { formatElapsed, formatStartTime, formatTimestamp, inferPhase, runStatusLabel } from '../utils/format';
import { AnsiPre, AskQuestion, Spinner } from './shared';

export function RunningView({
  tool,
  runId,
  question,
  scope,
  lines,
  startedAt,
  model,
}: {
  tool: ReviewRunTool;
  runId: string;
  /** /ask's question: shown directly while running too (consistent with queued / done state; the question was generated at dispatch). */
  question?: string;
  /** Single-commit review scope (parent..sha); shows the scope badge when limited to a commit, consistent with the done-state card. */
  scope?: ReviewRunCommitScope;
  lines: ReadonlyArray<string>;
  startedAt: number;
  /** The current active LLM profile.model — placed in the chip row from the same source as RunMeta, keeping running
      visually consistent with succeeded; optional (not shown when there's no active profile) */
  model: string | null;
}) {
  const { t } = useTranslation();
  // Auto-scroll to bottom when the last line is appended
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // Timer: lets users perceive it isn't stuck during long gaps in pr-agent stdout. 1s granularity is enough
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const phase = useMemo(() => inferPhase(lines, t), [lines, t]);
  const text = useMemo(() => lines.join('\n'), [lines]);

  // A chip row structurally identical to RunMeta. running shares one visual
  // skeleton with succeeded/failed, so a glance down the list shows tool / status / model / duration in fixed positions. strategy
  // runtime strategy is a deployment detail users don't care about, removed; model is the variable that actually affects review quality
  return (
    <div className="chat-run-running" data-run-id={runId}>
      <header className="chat-run-meta">
        <span className={`chat-run-tool chat-run-tool-${tool}`}>/{tool}</span>
        <span className="chat-chip chat-run-status chat-run-status-running">
          <Spinner />
          {runStatusLabel('running', t)}
        </span>
        {/* Single-commit scope badge: consistent with the done-state RunMeta, so the limited commit is visible while running too. */}
        {scope && (
          <span
            className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-scope"
            title={t('chatPane.scopeCommitTitle', { subject: scope.subject })}
          >
            <CommitIcon size={12} />
            {scope.abbreviatedSha}
          </span>
        )}
        {model && (
          <span
            className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-model"
            title={t('chatPane.modelTitle', { model })}
          >
            {model}
          </span>
        )}
        <span className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-duration">
          {formatElapsed(elapsedMs)}
        </span>
        {/* Start time: same pattern as RunMeta — plain text right-aligned, keeping the far-right element's position stable
            across the running and succeeded states */}
        <span
          className="chat-run-time"
          title={t('chatPane.startedAtTitle', { time: formatTimestamp(startedAt, { full: true }) })}
        >
          {formatStartTime(startedAt)}
        </span>
      </header>
      {/* /ask's question is shown directly while running too (the question is already generated, no need to wait for queued / done to be visible). */}
      {tool === 'ask' && question?.trim() && <AskQuestion text={question.trim()} />}
      {phase && (
        <div className="chat-chip chat-chip-md chat-chip-quiet chat-chip-accent chat-run-phase">
          {phase}
        </div>
      )}
      {/* Console output: collapsed by default while running, manually expandable (same collapse effect as the done-state「raw output」). */}
      <details className="chat-run-raw">
        <summary>{t('chatPane.rawOutput', { n: text.length })}</summary>
        <AnsiPre
          className="chat-run-stdout"
          preRef={ref}
          text={text}
          placeholder={t('chatPane.waitingOutput')}
        />
      </details>
    </div>
  );
}
