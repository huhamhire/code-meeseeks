import type { Finding, ReviewRun } from '@meebox/shared';

const HISTORY_BYTE_BUDGET = 24_000;
const TURN_LIMIT = 6;

function clip(text: string | undefined, max: number): string {
  return !text ? '' : text.length <= max ? text : `${text.slice(0, max)}…`;
}

function evidence(finding: Finding) {
  return {
    title: clip(finding.title, 240),
    anchor: finding.anchor,
    body: clip(finding.body, 1600),
  };
}

export function buildCodexAskContext(
  question: string,
  runs: readonly ReviewRun[],
  review: ReviewRun | undefined,
  reference: Finding | undefined,
): string {
  const recentTurns: { question: string; answer: string }[] = [];
  let remaining = HISTORY_BYTE_BUDGET - 2;
  for (const run of runs) {
    if (run.tool !== 'ask' || run.status !== 'succeeded' || !run.question || !run.summary) continue;
    const turn = { question: clip(run.question, 1400), answer: clip(run.summary, 3000) };
    const bytes = Buffer.byteLength(JSON.stringify(turn), 'utf8') + (recentTurns.length ? 1 : 0);
    if (bytes > remaining) break;
    remaining -= bytes;
    recentTurns.push(turn);
    if (recentTurns.length >= TURN_LIMIT) break;
  }
  const findings =
    review?.findings?.filter((finding) => finding.sectionKey === 'code-feedback') ?? [];
  const context = {
    selectedFinding: reference ? evidence(reference) : undefined,
    recentReview: review
      ? { summary: clip(review.summary, 2000), findings: findings.slice(0, 4).map(evidence) }
      : undefined,
    recentTurns: recentTurns.reverse(),
    currentQuestion: question,
  };
  return `PR review context and current question (JSON):\n${JSON.stringify(context)}`;
}
