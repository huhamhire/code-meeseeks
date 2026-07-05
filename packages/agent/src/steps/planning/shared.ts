import type {
  AgentMessage,
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentTodoItem,
} from '@meebox/shared';
import { HISTORY_BUDGET_CHARS, HISTORY_MESSAGE_MAX, VERDICTS } from '../../constants.js';
import type { MemoryNote } from '../../memory.js';
import type { AgentStepLabels } from '../../orchestrator.js';
import type { AgentMemoryNotes, PlanningDeps, PlanningInput } from '../../planner.js';
import { PROMPT_TEMPLATES } from '../../prompts.js';
import { clamp, fillTemplate } from '../../utils/index.js';
import type { StepRecorder } from '../context.js';

/**
 * Shared pieces for the free-form planning plan-cycle step: action types + parsing (memory / suggestion / plan),
 * conversation context and protocol assembly, run context.
 * See ./plan-cycle-step for the step itself, ../../planner for the driver.
 */

export interface PlannerAction {
  thought?: string;
  tool?: string;
  /**
   * Select multiple read-only tools in parallel at once (e.g. describe + review, or several /ask); mutually
   * exclusive with tool, tools takes precedence.
   * Elements may be a tool-name string, or a `{tool, question}` object — the latter dispatches several /ask
   * with questions in parallel within one round.
   */
  tools?: Array<string | { tool?: string; question?: string }>;
  question?: string;
  final?: string;
  /**
   * Plan (todo): the model may give / update a short step list in any action (mark done, reorder by priority, add/remove).
   * Elements may be a string or `{id?, text, done?}`. Omitted = plan unchanged (carry over the previous round). See the plan convention in buildProtocol.
   */
  plan?: Array<string | { id?: unknown; text?: unknown; done?: unknown }>;
  /** Non-binding judge suggestion for review-type summaries (verdict + reason); omitted for non-review requests. */
  recommendation?: { verdict?: unknown; reason?: unknown };
  /**
   * Proactively recorded **non-private** entries, grouped by the target writable file: user→USER.md (user info),
   * memory→MEMORY.md (long-term knowledge), agents→AGENTS.md (working conventions, append-only). SOUL.md is never written.
   */
  remember?: { user?: unknown; memory?: unknown; agents?: unknown };
}

/** Parse a single memory: must be an object with `section` + `note`; entries that can't be filed under a topic section are dropped (return null). */
function toNote(raw: unknown): MemoryNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { section?: unknown; note?: unknown };
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  const section = typeof obj.section === 'string' ? obj.section.trim() : '';
  if (!note || !section) return null;
  return { section, note };
}

/** Parse a target file's remember array into MemoryNote[] (fault-tolerant; drop entries that can't be classified). */
function toNoteList(raw: unknown): MemoryNote[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items.map(toNote).filter((n): n is MemoryNote => n !== null);
}

/** Accumulate one action's remember into acc (fault-tolerant; ignore non-objects). */
export function accumulateRemember(value: PlannerAction['remember'], acc: AgentMemoryNotes): void {
  if (!value || typeof value !== 'object') return;
  acc.user.push(...toNoteList(value.user));
  acc.memory.push(...toNoteList(value.memory));
  acc.agents.push(...toNoteList(value.agents));
}

/** Parse a valid recommendation from the summary action; invalid / missing verdict → undefined (don't force a judge). */
export function parseRecommendation(
  rec?: PlannerAction['recommendation'],
): AgentRecommendation | undefined {
  if (!rec) return undefined;
  const verdict = rec.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as AgentRecommendationVerdict)) {
    return undefined;
  }
  return {
    verdict: verdict as AgentRecommendationVerdict,
    reason: typeof rec.reason === 'string' ? rec.reason : '',
  };
}

/** Normalize the model's plan into AgentTodoItem[]: accept string / object, drop empty text; fill missing id in order. */
export function normalizePlan(raw: PlannerAction['plan']): AgentTodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentTodoItem[] = [];
  raw.forEach((it, i) => {
    if (typeof it === 'string') {
      const text = it.trim();
      if (text) out.push({ id: `s${String(i + 1)}`, text, done: false });
    } else if (it && typeof it === 'object') {
      const text = typeof it.text === 'string' ? it.text.trim() : '';
      if (text) {
        out.push({
          id: typeof it.id === 'string' && it.id ? it.id : `s${String(i + 1)}`,
          text,
          done: it.done === true,
        });
      }
    }
  });
  return out;
}

/** Take the most recent rounds, each length-capped, and trim newest-to-oldest by total budget (drop earlier over-budget messages), returning text in ascending time order. */
export function buildConversationContext(history: readonly AgentMessage[]): string {
  const lines: string[] = [];
  let budget = HISTORY_BUDGET_CHARS;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${clamp(m.content, HISTORY_MESSAGE_MAX)}`;
    if (line.length + 1 > budget) break; // budget exhausted: trim the earlier conversation entirely
    budget -= line.length + 1;
    lines.push(line);
  }
  return lines.reverse().join('\n');
}

/** Planning ReAct protocol: body is externalized in resources/prompts/protocol.md, the three section titles (localized per language) are injected via placeholders. */
export function buildProtocol(sections: readonly [string, string, string]): string {
  const [overview, findings, suggestions] = sections;
  return fillTemplate(PROMPT_TEMPLATES.protocol, { overview, findings, suggestions });
}

/** Run context for a single planning round (plan-cycle step): deps + input + shared recorder + cross-round accumulators. */
export interface PlanStepCtx {
  deps: PlanningDeps;
  input: PlanningInput;
  rec: StepRecorder;
  /** Full system (incl. Protocol), reused across rounds. */
  system: string;
  /** Prior multi-round conversation (text after budget trimming), reused across rounds. */
  convo: string;
  labels: AgentStepLabels;
  /** This round's progress accumulation (tool results / red-line rejection feedback), appended each round. */
  history: string[];
  /** Non-private entries proactively recorded this round, pending persistence, accumulated across rounds. */
  memories: AgentMemoryNotes;
  /** Current plan (todo), fed back as a prompt each round; updated whenever the model gives a plan (reorder / check / add/remove). */
  plan: AgentTodoItem[];
  /**
   * Upper bound on /ask count this session (follows the configured "follow-up ask count" max_followup_asks): consecutive /ask in
   * free-form planning (each an agentic exploration) is expensive, so it's capped here — unrelated to the "auto follow-up ask" toggle (which only constrains the review microflow).
   */
  maxAsks: number;
  /** Count of /ask already issued this session, accumulated across rounds; after reaching maxAsks, reject new /ask and feed back to push toward a summary. */
  asksUsed: number;
}

/** plan-cycle output: continue to the next round / summary (with final + optional suggestion) / user pause. */
export type PlanCycleOutcome =
  | { kind: 'continue' }
  | { kind: 'final'; finalText: string; recommendation?: AgentRecommendation }
  | { kind: 'aborted' };
