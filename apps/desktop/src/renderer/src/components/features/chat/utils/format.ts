import type { TFunction } from 'i18next';
import type { ReviewRun } from '@meebox/shared';

// Duration formatting lives in utils/time (status-bar compact version uses the compact option); re-exported here so chat components import it nearby.
export { formatElapsed } from '../../../../utils/time';

/** 1234 → "1.2k"; keeps 1 decimal place; < 1000 returns the number as-is */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function runStatusLabel(status: ReviewRun['status'], t: TFunction): string {
  switch (status) {
    case 'running':
      return t('chatPane.statusRunning');
    case 'succeeded':
      return t('chatPane.statusSucceeded');
    case 'failed':
      return t('chatPane.statusFailed');
    case 'cancelled':
      return t('chatPane.statusCancelled');
  }
}

/**
 * Format a timestamp as "HH:MM:SS" (same day) or "MM-DD HH:MM" (crossing days).
 * The user mainly cares about "which run"; second granularity is enough to tell
 * adjacent runs apart; runs from another day get a date marker so the history run
 * list groups them at a glance. Accepts an ISO string (persisted
 * ReviewRun.startedAt) or a millisecond timestamp (RunningView side passes the
 * Date.getTime() of the parsed ISO)
 */
export function formatStartTime(input: string | number): string {
  const d = new Date(input);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}`;
}

/**
 * Infer which phase pr-agent is currently in from the stdout lines received so
 * far. Before an LLM call pr-agent prints a few INFO markers ("Reviewing PR..." /
 * "Tokens: ... returning full diff" / ...), while the LLM call itself is minutes
 * of silence; matching known patterns against recent lines gives the user a more
 * accurate status hint.
 *
 * A /review on a large repo can total 5min+, and without this inference seeing
 * only spinner + elapsed makes it easy to think it is stuck.
 */
export function inferPhase(lines: ReadonlyArray<string>, t: TFunction): string {
  // Scan from the end backward for the most recent matching marker; a later marker means a "later" phase
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/returning full diff|tokens?\s*[:：]\s*\d+/i.test(line))
      return t('chatPane.phaseWaitingLlm');
    if (/answering a pr question|reviewing pr|generating a pr description/i.test(line))
      return t('chatPane.phaseAssemblingPrompt');
    if (/pr main language/i.test(line)) return t('chatPane.phaseParsingDiff');
    if (/response language/i.test(line)) return t('chatPane.phaseInitConfig');
  }
  return t('chatPane.phaseStarting');
}
