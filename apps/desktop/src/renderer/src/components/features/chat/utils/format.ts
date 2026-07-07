import type { TFunction } from 'i18next';
import type { ReviewRun } from '@meebox/shared';

// Duration / timestamp formatting live in utils/time; re-exported here so chat components import them nearby.
export { formatElapsed, formatTimestamp } from '../../../../utils/time';
import { formatTimestamp } from '../../../../utils/time';

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
 * Format a review run's start time in the house format: same day → "HH:mm:ss", other days →
 * "yyyy-mm-dd HH:mm:ss". The user mainly cares about "which run"; second granularity tells adjacent runs apart,
 * and runs from another day carry the date so the history list groups them at a glance. Accepts an ISO string
 * (persisted ReviewRun.startedAt) or a millisecond timestamp (RunningView passes the parsed ISO's getTime()).
 */
export function formatStartTime(input: string | number): string {
  return formatTimestamp(input);
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
