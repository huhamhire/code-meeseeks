import { useTranslation } from 'react-i18next';
import type { CodexProgressEntry } from '../../../../stores/chat-run-store';
import { formatElapsed } from '../utils/format';
import { Spinner } from './shared';

type Step = {
  phase: Extract<CodexProgressEntry, { phase: string }>['phase'];
  at: number;
  summaries: string[];
};

export function CodexProgress({
  entries,
  startedAt,
  elapsedMs,
}: {
  entries: readonly CodexProgressEntry[];
  startedAt: number;
  elapsedMs: number;
}) {
  const { t } = useTranslation();
  const steps: Step[] = [{ phase: 'preparing', at: startedAt, summaries: [] }];
  for (const entry of entries) {
    const latest = steps[steps.length - 1]!;
    if ('summary' in entry) {
      latest.summaries.push(entry.summary);
    } else if (entry.phase !== latest.phase) {
      steps.push({ phase: entry.phase, at: entry.at, summaries: [] });
    }
  }
  const current = steps[steps.length - 1]!;
  const now = startedAt + elapsedMs;
  const duration = (start: number, end: number) => formatElapsed(Math.max(0, end - start));
  return (
    <div className="chat-codex-progress">
      <div className="chat-codex-current">
        <Spinner />
        <span role="status">{t(`chatPane.codex.phase.${current.phase}`)}</span>
        <span className="chat-codex-time">{duration(current.at, now)}</span>
      </div>
      <details className="chat-run-raw chat-codex-steps">
        <summary>{t('chatPane.codex.progress')}</summary>
        <ol>
          {steps.map((step, index) => {
            const next = steps[index + 1];
            const heading = (
              <>
                <span>{t(`chatPane.codex.phase.${step.phase}`)}</span>
                <span className="chat-codex-time">{duration(step.at, next?.at ?? now)}</span>
              </>
            );
            return (
              <li key={step.phase} aria-current={next ? undefined : 'step'}>
                <span className="chat-codex-node" aria-hidden="true">
                  {next && '✓'}
                </span>
                {step.summaries.length ? (
                  <details>
                    <summary>{heading}</summary>
                    {step.summaries.map((summary, i) => (
                      <p key={i}>{summary}</p>
                    ))}
                  </details>
                ) : (
                  <div className="chat-codex-step-heading">{heading}</div>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </div>
  );
}
