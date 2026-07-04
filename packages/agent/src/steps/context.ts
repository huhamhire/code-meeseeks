import type { AgentStep, TokenUsage } from '@meebox/shared';

/**
 * Shared foundation for the agent step abstraction (see docs/arch/02-agent/01-agent.md): converges the "record one step + accumulate usage" that
 * planner (ReAct loop) and orchestrator (review microflow) each previously duplicated into a reusable StepRecorder, and provides a unified StepHandler
 * shape — each flow is a set of steps executed in order (review) or a single-step loop (planning); a new flow = a new combination of steps, in line with the reuse/extension path.
 */

/** Accumulate one token usage entry (tolerates omission; calls defaults to 1). Shared across orchestrations / steps. */
export function addUsage(acc: TokenUsage, u?: TokenUsage): TokenUsage {
  if (!u) return acc;
  return {
    promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
    completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
    calls: (acc.calls ?? 0) + (u.calls ?? 1),
  };
}

/**
 * Step recorder: converges "record one step" and "accumulate usage". `record()` stamps the step with a timestamp, enqueues it, and streams it out via onStep;
 * `track()` accumulates usage; `steps` / `usage` are cumulative reads. Each flow driver and its steps share the same instance.
 */
export interface StepRecorder {
  readonly steps: AgentStep[];
  readonly usage: TokenUsage;
  record(step: AgentStep): Promise<void>;
  track(u?: TokenUsage): void;
}

export function createStepRecorder(onStep?: (step: AgentStep) => void | Promise<void>): StepRecorder {
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};
  return {
    steps,
    get usage(): TokenUsage {
      return usage;
    },
    record: async (step: AgentStep): Promise<void> => {
      const stamped = { ...step, at: step.at ?? new Date().toISOString() };
      steps.push(stamped);
      await onStep?.(stamped);
    },
    track: (u?: TokenUsage): void => {
      usage = addUsage(usage, u);
    },
  };
}

/**
 * Abstract base class for pluggable steps: subclasses implement `run(ctx)`, executing a piece of orchestration logic (record step, call tool / LLM,
 * write back to accumulators) against a given run context `Ctx`, returning `R`. The review microflow is an ordered "registry" of `Step<Ctx>` (R=void) subclasses, run in order; planning is a single
 * `Step<Ctx, PlanCycleOutcome>` subclass, driven repeatedly until finalization. Each subclass has no instance state (all runtime state is in ctx), so they enter the registry as
 * singletons. `name` aids debugging / registry readability.
 */
export abstract class Step<Ctx, R = void> {
  abstract readonly name: string;
  abstract run(ctx: Ctx): Promise<R>;
}
