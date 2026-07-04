import type { AgentRecommendationVerdict } from '@meebox/shared';
import type { AgentContextFiles } from './types.js';

/**
 * Package-wide constants consolidated here: all value constants (scalars / strings / pure-data arrays and maps) are centralized here, for easy reuse and tuning.
 * Two kinds not consolidated (not "value constants"): the step registry (REVIEW_STEP_REGISTRY in steps/review/index.ts, the composition root instantiating each step class),
 * and ?raw resource-loaded objects (PROMPT_TEMPLATES in prompts.ts, AGENT_TEMPLATES in templates.ts) — they are the substance of their own modules.
 */

// ── review judge ──
/** Legal values for the review judge: the whitelist shared by planning summary (steps/planning) and the review micro-flow (steps/review) when parsing recommendations. */
export const VERDICTS: readonly AgentRecommendationVerdict[] = [
  'approve',
  'needs_work',
  'manual_review',
];

// ── Agent directory layout ──
/**
 * The Agent directory's fixed file layout (see docs/arch/02-agent/01-agent.md「Agent 目录」).
 * - SOUL.md  soul: core responsibilities and boundaries (Agent read-only, defaults set by the template)
 * - AGENTS.md work conventions and red lines
 * - MEMORY.md long-term memory (writable)
 * - USER.md  user profile (writable)
 */
export const AGENT_FILES = {
  soul: 'SOUL.md',
  agents: 'AGENTS.md',
  memory: 'MEMORY.md',
  user: 'USER.md',
} as const;

/** rules/ subdirectory name: where rule bodies are stored, matching semantics in @meebox/rules (docs/arch/02-agent/04-rules.md). */
export const AGENT_RULES_SUBDIR = 'rules';

/** All-empty context file set: the fail-safe fallback for empty agentDir / read failures (Agent degrades to native). */
export const EMPTY_FILES: AgentContextFiles = { soul: '', agents: '', memory: '', user: '' };

// The tool list (read / write / grant) is consolidated into @meebox/shared's unified registry tool-registry (TOOLS);
// the tool catalog is derived from it by buildToolCatalog, see tool-catalog.ts.

// ── tool concurrency stagger (see stagger.ts) ──
/**
 * Stagger concurrently dispatched tool calls by a cumulative random delay: the first is sent immediately, each of the rest
 * starts [MIN, MIN+SPAN]ms after the previous, avoiding different tools firing at the same instant and contending for subprocess spawn / LLM network.
 * The actual per-step delay ∈ [100, 200]ms.
 */
export const STAGGER_MIN_MS = 100;
export const STAGGER_SPAN_MS = 100;

// ── planning (ReAct) ──
/** Max number of tools dispatched in parallel at once: truncated on multi-select, to prevent firing too many pr-agent runs in one round. */
export const MAX_PARALLEL_TOOLS = 3;

/**
 * History conversation budget injected into the planning context: per-message char cap + total char budget (accumulated from newest backward, trimming older ones once over budget).
 * Convention is that the session context does not exceed half the LLM context window — using chars to approximate tokens as a conservative cap: 64k chars ≈ 16~40k tokens.
 */
export const HISTORY_MESSAGE_MAX = 2000;
export const HISTORY_BUDGET_CHARS = 64000;

// ── follow-up ask judging (steps/review) ──
/** Compact system prompt for the follow-up ask judgment: without the agent's full context (SOUL / memory / user profile / tool catalog / rules / PR metadata).
 *  This is a lightweight routing judgment, deciding "whether there are severe issues needing a follow-up ask" from describe + review results alone, following the same idea as AutoPilot's initial judgment. */
export const JUDGE_SYSTEM =
  'You are a senior code reviewer triaging review findings for follow-up. Be decisive and terse; reply with JSON only, no reasoning.';

/** Output token cap for the follow-up ask judgment: the product is tiny JSON (severe + at most a few issues), no large budget needed. */
export const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** Output token cap for the summary: the summary is a whole markdown synthesis (three sections + a trailing judgment JSON), give ample budget to avoid being truncated by the provider's
 *  default cap (truncation would also drop the trailing judgment → falls back to manual_review). summaryMax is a soft char guide, this is a hard cap. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 4096;

// ── AutoPilot admission judgment (autopilot-judge.ts) ──
/** Char truncation count before feeding candidate PR descriptions to the judging LLM: controls prompt size, the admission judgment does not need the full description. */
export const DESC_CLAMP = 600;

// ── system context assembly (assemble.ts) ──
/**
 * Cache-break marker: inserted between the "global stable prefix" and the "PR/run-related tail" (including the --- separators on both sides). The embedded shim uses it to
 * mark the stable prefix alone for Anthropic prompt caching (1h), hitting across PRs/runs, while the tail stays plain text; after the consumer splits / strips it the marker never
 * enters the prompt sent to the model (handled by both litellm chunking and CLI concatenation).
 * **Must be byte-for-byte identical to `CACHE_BREAK` in scripts/pragent-shim/meebox_pragent_shim/runtime.py.**
 */
export const CACHE_BREAK = '\n\n---\n\n[[MEEBOX:CACHE_BREAK]]\n\n---\n\n';
