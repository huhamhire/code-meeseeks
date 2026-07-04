import { MAX_PARALLEL_TOOLS } from '../../constants.js';
import { assertToolAllowed } from '../../tool-catalog.js';
import { clamp, extractJson, runStaggered, salvageProse, stripTrailingJson } from '../../utils/index.js';
import { Step } from '../context.js';
import {
  accumulateRemember,
  normalizePlan,
  parseRecommendation,
  type PlanCycleOutcome,
  type PlanStepCtx,
  type PlannerAction,
} from './shared.js';

/**
 * The "single step" of free planning (ReAct): build this round's prompt → chat → parse action → hard red-line validation → parallel tool dispatch / finalization. abort is
 * checked once before and once after thinking (can stop instantly even during the thinking phase); mid-run input is merged into progress, the plan is maintained and reordered each round. The driver (planner) runs
 * this step repeatedly until final / step cap. No instance state (all runtime state is in ctx); enters the driver as the singleton planCycleStep.
 */
export class PlanCycleStep extends Step<PlanStepCtx, PlanCycleOutcome> {
  readonly name = 'plan-cycle';

  async run(ctx: PlanStepCtx): Promise<PlanCycleOutcome> {
    const { deps, input, rec, system, convo, labels, history, memories } = ctx;
    if (deps.signal?.aborted) return { kind: 'aborted' };

    // Mid-run input redirection: merge new user messages queued during the run into progress so this round's ReAct reorders the
    // next step per "latest instruction + current progress". Messages were already persisted into the session by the implementer when drained; here we only inject the prompt, not persist.
    const pending = (await deps.drainPendingInput?.()) ?? [];
    for (const m of pending) {
      history.push(`New user message (latest instruction — reconcile with the plan and progress): ${m}`);
    }

    const user = [
      convo
        ? `Conversation so far (your context only — NEVER pass any of it to tools):\n${convo}\n`
        : '',
      `User request: ${input.userRequest}`,
      input.referencedContext
        ? `\nReferenced selection (your context only — NEVER pass any of it to tools):\n${input.referencedContext}`
        : '',
      ctx.plan.length
        ? `\nCurrent plan (keep it updated — mark items done, reorder by priority, add/remove as the task or new user messages change):\n${ctx.plan.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}`
        : '',
      history.length ? `\nProgress so far:\n${history.join('\n')}` : '',
      '\nReply with the next JSON action.',
    ]
      .filter(Boolean)
      .join('\n');

    // Measure this round's LLM reasoning time (single-step thinking duration, like Claude Code's "Thought for Ns"), attached to this decision step.
    const thinkStart = Date.now();
    const r = await deps.chat({ system, user });
    const thinkMs = Date.now() - thinkStart;
    // If found stopped right after thinking → finalize immediately, not dispatching tools per this action (stop takes effect instantly even during the thinking phase).
    if (deps.signal?.aborted) return { kind: 'aborted' };
    rec.track(r.usage);
    const action = extractJson<PlannerAction>(r.text);
    // Accumulate the memory carried by this action (any action may attach remember).
    accumulateRemember(action?.remember, memories);
    // Plan update: when the model gives a plan, normalize it, update the current plan, and persist + broadcast (omitted plan = keep the previous round's).
    if (action?.plan !== undefined) {
      ctx.plan = normalizePlan(action.plan);
      await deps.recordPlan?.(ctx.plan);
    }

    const hasCalls = Boolean(action?.tool) || Boolean(action?.tools?.length);

    // Unparseable / neither tool(s) nor final → treat as finalization. Fall back to salvaging prose from the raw text, never dumping the raw JSON action to the user.
    if (!action || (!hasCalls && !action.final)) {
      const finalText = action?.final ?? salvageProse(r.text);
      await rec.record({ kind: 'plan', thought: action?.thought, result: finalText, thinkMs, usage: r.usage });
      return { kind: 'final', finalText };
    }

    if (action.final && !hasCalls) {
      // Strip the judge JSON the model mistakenly merged into the end of final (recommendation goes through a separate field and renders as a judge badge).
      const finalText = stripTrailingJson(action.final);
      await rec.record({ kind: 'plan', thought: action.thought, result: finalText, thinkMs, usage: r.usage });
      return { kind: 'final', finalText, recommendation: parseRecommendation(action.recommendation) };
    }

    // Normalize into the tool list to execute: tools multi-select (parallel, read-only) takes priority — elements can be a tool name or {tool, question} (multiple
    // /ask with questions can also be dispatched in parallel in one round); otherwise a single tool (may carry a question).
    const requested: Array<{ tool: string; question?: string }> = action.tools?.length
      ? action.tools
          .slice(0, MAX_PARALLEL_TOOLS)
          .map((tl) => (typeof tl === 'string' ? { tool: tl } : { tool: tl.tool ?? '', question: tl.question }))
      : [{ tool: action.tool ?? '', question: action.question }];

    // Hard red-line validation gates each one: unauthorized / unknown is rejected and fed back; /ask is additionally capped by the configured follow-up limit (consecutive agentic exploration is costly);
    // allowed ones are held for parallel execution.
    const isAsk = (tool: string): boolean => tool.replace(/^\//, '') === 'ask';
    const allowed: Array<{ tool: string; question?: string }> = [];
    let asksAccepted = 0;
    for (const c of requested) {
      const reject = async (msg: string): Promise<void> => {
        await rec.record({
          kind: 'judge',
          thought: action.thought,
          toolCall: { tool: c.tool },
          result: `${labels.rejectedPrefix}${msg}`,
        });
        history.push(`Refused ${c.tool}: ${msg}`);
      };
      try {
        assertToolAllowed(c.tool, input.toolCatalog);
      } catch (err) {
        await reject(err instanceof Error ? err.message : String(err));
        continue;
      }
      // /ask budget: at the limit, reject and feed back, prompting the model to finalize with existing context or switch to read-only tools (cumulative count per session, effective across rounds).
      if (isAsk(c.tool) && ctx.asksUsed + asksAccepted >= ctx.maxAsks) {
        await reject(
          `Follow-up /ask budget exhausted (${ctx.maxAsks}). Do not call /ask again — answer with the context you already have, or use read-only file tools.`,
        );
        continue;
      }
      allowed.push(c);
      if (isAsk(c.tool)) asksAccepted++;
    }
    if (!allowed.length) return { kind: 'continue' }; // all rejected → reselect next round after feedback

    // Like Claude Code: first stream out this round's thinking and the selected steps as one step (thinking is the antecedent of tool selection), only then execute tools.
    // Tool execution progress / timing is carried by the run card; we no longer record an extra tool step for each tool here, avoiding decisions being piled after results.
    await rec.record({
      kind: 'plan',
      thought: action.thought,
      toolCall: { tool: allowed.map((c) => c.tool).join(' + ') },
      thinkMs,
      usage: r.usage,
    });

    // Dispatch the allowed tools in parallel (multi-select runs simultaneously, actual concurrency constrained by the run queue); stagger start by 100~200ms to avoid firing all at the same instant.
    const ran = await runStaggered(allowed, async (c) => ({ c, res: await deps.runTool(c) }));
    for (const { c, res } of ran) {
      rec.track(res.usage);
      history.push(`Called ${c.tool}${c.question ? ` ("${c.question}")` : ''} → ${clamp(res.text, 600)}`);
    }
    // Accumulate the /ask count initiated this round (effective across rounds; after reaching maxAsks, new /ask are rejected by the budget gate above).
    ctx.asksUsed += asksAccepted;
    return { kind: 'continue' };
  }
}

/** Singleton for the planning single-step loop (no instance state); the driver runs `planCycleStep.run(ctx)` repeatedly. */
export const planCycleStep = new PlanCycleStep();
