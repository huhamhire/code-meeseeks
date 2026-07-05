import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentStep } from '@meebox/shared';
import { RobotIcon } from '../../../common';
import { formatElapsed } from '../utils/format';
import { Md, Spinner, TokenStat } from './shared';

/**
 * Inline thinking step (Claude Code-like "think first → decide steps → execute steps"): interleaved
 * in the timeline, ordered before the selected tool's run card. Two-line display — the first line has
 * a bullet marker "thought for xx s" (single-step thinking time, not cumulative total), the second
 * line separately shows the step result (thinking content / judgment conclusion). Does not show which
 * tool was selected (reflected by the subsequent run card); tool execution progress / timing also
 * belong to the run card.
 */
export function AgentStepRow({ step }: { step: AgentStep }) {
  const { t } = useTranslation();
  // The first line always has a bullet marker: with thinking timer → "thought for xx s"; without a
  // timer (e.g. a micro-flow's fixed dispatch step) → use the thinking content as the first line,
  // ensuring every step is visible and has a segment marker, never rendered as an empty line.
  const hasTime = step.thinkMs != null;
  const headText = hasTime
    ? t('chatPane.agent.thoughtFor', { time: formatElapsed(step.thinkMs ?? 0) })
    : step.thought;
  return (
    <div className="chat-agent-step" role="note">
      <div className="chat-agent-step-head">
        <span className="chat-agent-step-bullet" aria-hidden>
          •
        </span>
        {/* The first step of an AutoPilot background review gets a robot chip, marking "this review was triggered by AutoPilot". */}
        {step.autopilot && (
          <span className="chat-agent-step-autopilot" title={t('chatPane.autopilotRun')}>
            <RobotIcon size={12} />
          </span>
        )}
        {headText && <span>{headText}</span>}
        {/* This step's **standalone** token usage (not cumulative): reasoning steps via an independent LLM
            channel like judge / summary / planning carry a value; same style as the run card ↑input(green)
            [⛁cache]/↓output(red), input and output hover independently, aligned to the line end.
            describe/review/ask costs are on their respective run cards. */}
        {step.usage &&
        (step.usage.promptTokens !== undefined || step.usage.completionTokens !== undefined) ? (
          <span className="chat-agent-step-tokens">
            <TokenStat
              prompt={step.usage.promptTokens}
              completion={step.usage.completionTokens}
              cacheRead={step.usage.cacheReadTokens}
              separator=" "
            />
          </span>
        ) : null}
      </div>
      {/* Thinking / judgment body goes through markdown: preserves line breaks and renders preformatted
          content (code blocks / lists / inline code), consistent with assistant replies; plain-text
          content renders unchanged. */}
      {hasTime && step.thought && (
        <div className="chat-agent-step-body markdown">
          <Md>{step.thought}</Md>
        </div>
      )}
      {step.kind === 'judge' && step.result && (
        <div className="chat-agent-step-body markdown muted">
          <Md>{step.result}</Md>
        </div>
      )}
    </div>
  );
}

/**
 * Live "thinking" indicator: mounted only when the Agent's own LLM is reasoning (no tool run occupying /
 * queued). The timer is anchored to the passed-in `since` (the moment the most recent activity ended,
 * computed by the parent from persisted data) rather than component mount — switching away and back does
 * not reset it; once a new step is produced, since advances forward → the timer restarts from zero for
 * the current step (still single-step thinking duration, not cumulative total).
 * The first-line layout aligns with completed steps: the spinner acts as the in-progress bullet marker,
 * with the timer right after "thinking".
 */
export function ThinkingLive({ since }: { since: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="chat-agent-step" role="status">
      <div className="chat-agent-step-head">
        <Spinner />
        <span>
          {t('chatPane.agent.thinking')} {formatElapsed(Math.max(0, now - since))}
        </span>
      </div>
    </div>
  );
}
