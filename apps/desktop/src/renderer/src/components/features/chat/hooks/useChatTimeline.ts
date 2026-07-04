import { useMemo } from 'react';
import type { PragentRunInfo } from '@meebox/ipc';
import type { AgentMessage, AgentStep, ReviewRun } from '@meebox/shared';

/** One timeline entry: the carrier for the four content kinds (run card / in-progress run / thinking step / conversation message) merged by start time. */
export interface TimelineEntry {
  key: string;
  sortTime: number;
  run: ReviewRun | null;
  active: PragentRunInfo | null;
  step: AgentStep | null;
  message: AgentMessage | null;
}

function ms(iso: string | null | undefined): number {
  const n = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Echo text for slash commands directly triggered by the user: /ask shows the question body (closer to conversation; empty question falls back to `/ask`),
 * describe/review/improve show `/toolName`. Used only for the command echo bubble, no i18n (it's literally the command the user typed).
 */
function echoContent(tool: string, question: string | undefined): string {
  if (tool === 'ask') {
    const q = question?.trim();
    if (q) return q;
  }
  return `/${tool}`;
}

/**
 * History timeline + real-time "thinking" timing anchor.
 *
 * timeline: merge-sorts completed runs, in-progress runs, Agent thinking steps, and conversation messages uniformly by **start time**,
 * with a fixed order — even if a later-started task finishes first, it still sits below the earlier-started (still-executing) task, never jumping order by completion.
 * Like Claude Code's "think first → decide steps → execute steps": thinking steps (plan/judge) are the antecedent of tool selection, placed before the chosen tool's
 * run card; the tool execution's progress / timing is carried by the run card, not duplicated. Queued (not-yet-started) tasks are not in this list, placed separately at the end.
 *
 * thinkingSince: the anchor for real-time "thinking" timing, taking "the most recent activity end" — the latest of {this PR's run start, last thinking step at,
 * last completed run's finish time}. Anchored to persistent data (runningPrs is not cleared across PR switch, run history is reloaded) rather than
 * component mount, so switching away and back does not reset it; uses run end rather than the step record time, to avoid counting tool execution time into the current thinking.
 */
export function useChatTimeline(params: {
  visibleRuns: ReviewRun[];
  myActiveRuns: ReadonlyArray<PragentRunInfo>;
  agentSteps: AgentStep[];
  messages: AgentMessage[];
  runningPrs: Map<string, number>;
  prLocalId: string | undefined;
}): { timeline: TimelineEntry[]; thinkingSince: number } {
  const { visibleRuns, myActiveRuns, agentSteps, messages, runningPrs, prLocalId } = params;

  const timeline = useMemo<TimelineEntry[]>(() => {
    const base = {
      run: null as ReviewRun | null,
      active: null as PragentRunInfo | null,
      step: null as AgentStep | null,
      message: null as AgentMessage | null,
    };
    const runEntries = visibleRuns.map((r) => ({
      ...base,
      key: `run-${r.id}`,
      sortTime: ms(r.startedAt),
      run: r as ReviewRun | null,
    }));
    const activeEntries = myActiveRuns.map((a) => ({
      ...base,
      key: `active-${a.runId}`,
      sortTime: ms(a.startedAt ?? a.enqueuedAt),
      active: a as PragentRunInfo | null,
    }));
    const stepEntries = agentSteps.map((s, i) => ({
      ...base,
      key: `step-${i}-${s.at ?? ''}`,
      sortTime: ms(s.at),
      step: s as AgentStep | null,
    }));
    const msgEntries = messages.map((m, i) => ({
      ...base,
      key: `msg-${i}-${m.at}`,
      sortTime: ms(m.at),
      message: m as AgentMessage | null,
    }));
    // Command echo bubble: only for runs **directly triggered by the user** (origin==='user'), add a user message right above its card
    // (sortTime takes the start time -1ms). Orchestration / AutoPilot sub-runs (origin==='agent') are not echoed — their user input is already
    // carried by the orchestration session's user message. Historical runs have no origin (undefined) → not echoed. active and completed states are mutually exclusive on the same runId,
    // key uniformly `echo-<runId>`, so the running→completed switch is smooth without remounting.
    const echoOf = (
      runId: string,
      tool: string,
      question: string | undefined,
      anchorMs: number,
    ) => ({
      ...base,
      key: `echo-${runId}`,
      sortTime: anchorMs - 1,
      message: { role: 'user', content: echoContent(tool, question), at: '' } as AgentMessage,
    });
    const echoEntries = [
      ...visibleRuns
        .filter((r) => r.origin === 'user')
        .map((r) => echoOf(r.id, r.tool, r.question, ms(r.startedAt))),
      ...myActiveRuns
        .filter((a) => a.origin === 'user')
        .map((a) => echoOf(a.runId, a.tool, a.question, ms(a.startedAt ?? a.enqueuedAt))),
    ];
    return [...runEntries, ...activeEntries, ...stepEntries, ...msgEntries, ...echoEntries].sort(
      (a, b) => a.sortTime - b.sortTime,
    );
  }, [visibleRuns, myActiveRuns, agentSteps, messages]);

  const thinkingSince = useMemo(() => {
    const cands: number[] = [];
    const since = prLocalId !== undefined ? runningPrs.get(prLocalId) : undefined;
    if (since !== undefined) cands.push(since);
    const lastStepAt = agentSteps[agentSteps.length - 1]?.at;
    if (lastStepAt) {
      const t = new Date(lastStepAt).getTime();
      if (Number.isFinite(t)) cands.push(t);
    }
    const lastRun = visibleRuns[visibleRuns.length - 1];
    const lastRunEnd = lastRun?.finishedAt ?? lastRun?.startedAt;
    if (lastRunEnd) {
      const t = new Date(lastRunEnd).getTime();
      if (Number.isFinite(t)) cands.push(t);
    }
    return cands.length ? Math.max(...cands) : Date.now();
  }, [runningPrs, prLocalId, agentSteps, visibleRuns]);

  return { timeline, thinkingSince };
}
