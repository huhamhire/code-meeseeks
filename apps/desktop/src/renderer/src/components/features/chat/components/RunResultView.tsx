import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Finding, FindingClosure, ReviewDraft, ReviewRun } from '@meebox/shared';
import { CommitIcon, RepeatIcon, RetryIcon, ShareIcon, TrashIcon } from '../../../common';
import { orderFindings } from '../utils/findings';
import { formatStartTime, formatTimestamp, runStatusLabel } from '../utils/format';
import { extractTokenUsage, type TokenUsage } from '../utils/tokens';
import { AnsiPre, AskQuestion, BreakablePath, TokenStat } from './shared';
import { FindingCard } from './FindingCard';

function RunMeta({ run, onDelete }: { run: ReviewRun; onDelete: () => void }) {
  const { t } = useTranslation();
  const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—';
  // Prefer run.tokenUsage (the real API usage captured by the litellm callback, see sitecustomize);
  // fall back to the old estimate scraped from stdout when historical runs lack this field, for backward compatibility.
  const usage: TokenUsage = run.tokenUsage
    ? {
        prompt: run.tokenUsage.promptTokens,
        completion: run.tokenUsage.completionTokens,
        total: run.tokenUsage.totalTokens,
        cacheRead: run.tokenUsage.cacheReadTokens,
        turns: run.tokenUsage.turns,
      }
    : run.stdout
      ? extractTokenUsage(run.stdout)
      : {};
  return (
    <header className="chat-run-meta">
      <span className={`chat-run-tool chat-run-tool-${run.tool}`}>/{run.tool}</span>
      <span className={`chat-chip chat-run-status chat-run-status-${run.status}`}>
        {runStatusLabel(run.status, t)}
      </span>
      {/* Single-commit review scope badge: shows the short SHA when this run is limited to a commit's own changes (parent..sha);
          not rendered for full PR scope (no scope). */}
      {run.scope && (
        <span
          className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-scope"
          title={t('chatPane.scopeCommitTitle', { subject: run.scope.subject })}
        >
          <CommitIcon size={12} />
          {run.scope.abbreviatedSha}
        </span>
      )}
      {/* Model chip replaces the runtime strategy chip — strategy is a deployment detail users don't
          care about, model is the variable that actually affects review quality */}
      {run.model && (
        <span
          className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-model"
          title={t('chatPane.modelTitle', { model: run.model })}
        >
          {run.model}
        </span>
      )}
      {/* input(↑green)[⛁cache]/output(↓red): input and output each hover independently; cache is part of input, hidden on no match. Old runs may have only prompt */}
      {usage.prompt !== undefined || usage.completion !== undefined ? (
        <span className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-tokens">
          <TokenStat
            prompt={usage.prompt}
            completion={usage.completion}
            cacheRead={usage.cacheRead}
          />
        </span>
      ) : null}
      {/* Model interaction turns: loop arrow icon + count (replaces the「N turns」text, saving space / avoiding plurals); shown only for multi-turn (agentic) */}
      {usage.turns !== undefined && usage.turns > 1 ? (
        <span
          className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-turns"
          title={t('chatPane.turnsTitle')}
        >
          <RepeatIcon />
          {usage.turns}
        </span>
      ) : null}
      <span className="chat-chip chat-chip-quiet chat-chip-neutral chat-run-duration">
        {duration}
      </span>
      {/* Start time: plain text with no pill background, margin-left:auto pushes it to the far right — spaced apart from the left-side
          tool/status/strategy chips, one visual weight lighter than a chip */}
      <span
        className="chat-run-time"
        title={t('chatPane.startedAtTitle', { time: formatTimestamp(run.startedAt, { full: true }) })}
      >
        {formatStartTime(run.startedAt)}
      </span>
      {/* Delete this run record: the small trash button at the far right of the status row (deletes only this run, no effect on other records / badges). */}
      <button
        type="button"
        className="chat-run-delete"
        onClick={onDelete}
        title={t('chatPane.deleteRunTitle')}
        aria-label={t('chatPane.deleteRunAria')}
      >
        <TrashIcon />
      </button>
    </header>
  );
}

export function RunResultView({
  run,
  onRetry,
  onDelete,
  canRetry,
  drafts,
  closures,
  onJumpToDraft,
  onRejectFinding,
  onNavigateToFinding,
  onReferenceFinding,
  onScrollToRun,
  onScrollToFinding,
}: {
  run: ReviewRun;
  onRetry: (run: ReviewRun) => void;
  /** Delete this run record (this run only). */
  onDelete: (runId: string) => void;
  /** Determined by the parent as "last one + no active run"; when false, failed / cancelled runs also don't show the retry button */
  canRetry: boolean;
  /** Snapshot of this PR's current draft pool; FindingCard uses it to show the status chip + decide reject behavior */
  drafts: ReadonlyArray<ReviewDraft>;
  /** Snapshot of this PR's finding closure relations (read-only); looks up the review-closed state by (run.id,finding.id), marking the read-only chip. */
  closures: ReadonlyArray<FindingClosure>;
  /** Fired when clicking "→ jump to code edit" on a finding card. The parent does lazy creation + jump */
  onJumpToDraft: (finding: Finding, run: ReviewRun) => void;
  /** Reject a finding: create / update a draft to status='rejected' */
  onRejectFinding: (finding: Finding, run: ReviewRun) => void;
  /** Click a finding anchor: only navigate to the corresponding Diff line (no edit mode) */
  onNavigateToFinding: (finding: Finding) => void;
  /** 「Reference」a code finding to start a re-review /ask (attach to the input bar). */
  onReferenceFinding: (finding: Finding, run: ReviewRun) => void;
  /** Scroll to a given run card (review-closed state「view re-review」→ the ask run that closed it). */
  onScrollToRun: (runId: string) => void;
  /** Scroll to a given finding card within a run and flash-highlight it (reference badge at the top of the re-review card → original finding card). */
  onScrollToFinding: (runId: string, findingId: string) => void;
}) {
  const { t } = useTranslation();
  const findings = run.findings ?? [];
  // Both failed + cancelled use a red banner. Cancel is a deliberate user action, so the UI distinguishes it with lighter wording
  const isFailed = run.status === 'failed';
  const isCancelled = run.status === 'cancelled';
  const isFailedOrCancelled = isFailed || isCancelled;
  const stdout = run.stdout ?? '';
  // The "raw output" collapse region maintains per-run state independently, unaffecting each other. Failed / cancelled default to expanded for easier troubleshooting,
  // success defaults to closed as just a diagnostic fallback
  const [showRawStdout, setShowRawStdout] = useState(isFailedOrCancelled);
  // /ask tool: show the user's question **below** the meta row, grouped with the /ask action;
  // putting a user bubble above would duplicate the meta row's info source, moving it below the action better fits the "action → input" order
  const userMessage = run.tool === 'ask' ? run.question?.trim() : undefined;
  return (
    <div className="chat-run-result">
      <RunMeta run={run} onDelete={() => onDelete(run.id)} />
      {/* Re-review /ask: top reference-locator badge (forward arrow + full path:line), click to scroll to the run of the referenced original finding.
          Shows the full locator info directly (no more「re-reviewed from」text, saving i18n); path wrapping follows code-suggestion location (BreakablePath soft break points). */}
      {run.referencedFinding && (
        <button
          type="button"
          className="chat-run-ref-badge"
          onClick={() =>
            onScrollToFinding(run.referencedFinding!.runId, run.referencedFinding!.findingId)
          }
          title={run.referencedFinding.anchor?.path}
        >
          <ShareIcon size={12} />
          {run.referencedFinding.anchor && (
            <span className="chat-run-ref-loc">
              <code>
                <BreakablePath path={run.referencedFinding.anchor.path} />
              </code>
              {run.referencedFinding.anchor.startLine !== undefined && (
                <span>
                  :{run.referencedFinding.anchor.startLine}
                  {run.referencedFinding.anchor.endLine &&
                  run.referencedFinding.anchor.endLine !== run.referencedFinding.anchor.startLine
                    ? `-${String(run.referencedFinding.anchor.endLine)}`
                    : ''}
                </span>
              )}
            </span>
          )}
        </button>
      )}
      {userMessage && <AskQuestion text={userMessage} />}
      {/* Raw output: always right after the meta row, so users can find logs in a fixed position in any state.
          Failed / cancelled default to expanded, success defaults to collapsed */}
      {stdout.length > 0 && (
        <details
          className="chat-run-raw"
          open={showRawStdout}
          onToggle={(e) => {
            if (e.currentTarget.open !== showRawStdout) setShowRawStdout(e.currentTarget.open);
          }}
        >
          <summary>{t('chatPane.rawOutput')}</summary>
          <AnsiPre className="chat-run-stdout" text={stdout} />
        </details>
      )}
      {isFailedOrCancelled && (
        <div className="chat-error" role="alert">
          <strong>
            {isCancelled
              ? t('chatPane.runCancelled')
              : run.errorReason === 'llm-error'
                ? t('chatPane.llmCallFailed')
                : run.errorReason
                  ? t('chatPane.runFailedReason', { reason: run.errorReason })
                  : t('chatPane.runFailed')}
            {/* On llm-error the exitCode is 0 (pr-agent caught it itself), showing it would instead
                mislead users into thinking nothing went wrong, so skip it */}
            {run.exitCode != null &&
              !isCancelled &&
              run.errorReason !== 'llm-error' &&
              ` · exit ${String(run.exitCode)}`}
          </strong>
          {canRetry && (
            <button
              type="button"
              className="chat-run-retry"
              onClick={() => onRetry(run)}
              title={
                run.question
                  ? t('chatPane.retryWithQuestionTitle', { tool: run.tool, question: run.question })
                  : t('chatPane.retryTitle', { tool: run.tool })
              }
              aria-label={t('chatPane.retryAria')}
            >
              <RetryIcon />
            </button>
          )}
          {run.errorMessage && !isCancelled && (
            <pre className="chat-error-detail">{run.errorMessage}</pre>
          )}
          {/* Failed / cancelled no longer show a separate output block: the pr-agent log is already in the collapsible「raw output」above (stdout contains
              the [pr-agent stdout log] segment, same source as stderr), avoiding duplicating the same log into two blocks. */}
        </div>
      )}

      {/* Failed / cancelled don't render findings: a cancelled /describe would parse part of stdout into「paragraphs」and mistakenly show them as results.
          Failed / cancelled uniformly keep only the collapsible「raw output」above + the status banner, not opening another output block below. */}
      {!isFailedOrCancelled &&
        (findings.length > 0 ? (
          <ul className="chat-finding-list">
            {orderFindings(findings).map((f) => {
              // Findings within the same run map one-to-one to drafts: looked up by source.runId+findingId. On match,
              // FindingCard uses it to show the status chip + branch the jump/reject button behavior
              const relatedDraft = drafts.find(
                (d) =>
                  d.source !== undefined &&
                  d.source.runId === run.id &&
                  d.source.findingId === f.id,
              );
              // Review-closed state (read-only): looked up when this finding was auto-closed by a re-review /ask ruling replace/drop.
              const closure = closures.find((c) => c.runId === run.id && c.findingId === f.id);
              // 「Reference」is only offered for anchorable code-type findings (review/improve) — they are the code comments that can be re-reviewed.
              const canReference =
                (f.sectionKey === 'code-feedback' || f.sectionKey === 'code-suggestion') &&
                typeof f.anchor?.startLine === 'number';
              return (
                <FindingCard
                  key={f.id}
                  finding={f}
                  relatedDraft={relatedDraft}
                  closure={closure}
                  onJump={() => onJumpToDraft(f, run)}
                  onReject={() => onRejectFinding(f, run)}
                  onNavigate={() => onNavigateToFinding(f)}
                  onReference={canReference ? () => onReferenceFinding(f, run) : undefined}
                  onViewAsk={closure ? () => onScrollToRun(closure.byAskRunId) : undefined}
                />
              );
            })}
          </ul>
        ) : run.status === 'succeeded' ? (
          <div className="chat-finding-empty muted">{t('chatPane.noFindings')}</div>
        ) : null)}
    </div>
  );
}
