/**
 * Unified tool registry (single source of truth, see docs/arch/02-agent/01-agent.md "tool mutation red line"). Add / adjust tools only here,
 * and the following derivations follow automatically:
 * - `ReviewRunTool`: pr-agent run-queue tool ids (`isRun`).
 * - agent tool catalog `buildToolCatalog`: marks read / mutating by `kind`, allows mutating ones by `grant` (red-line policy lives in the agent layer).
 * - planning red-line allowed set: `READ_RUN_TOOL_IDS`.
 */

/** Tool read / mutate classification. read is always available; mutating has remote side effects, disabled by default, allowed only by grant. */
export type ToolKind = 'read' | 'mutating';

export interface ToolSpec {
  /** Canonical id (no slash), e.g. `describe`. */
  id: string;
  /** Display / invocation name (with slash), e.g. `/describe`. */
  command: string;
  /** One-line description (injected into the tool-catalog prompt; LLM-facing, English). */
  summary: string;
  kind: ToolKind;
  /** grant key required to allow a mutating tool; omitted for read tools. */
  grant?: string;
  /** Whether this is a pr-agent run-queue tool (produces a ReviewRun via the run-queue). */
  isRun: boolean;
}

export const TOOLS = [
  {
    id: 'describe',
    command: '/describe',
    summary: 'Generate the PR description.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'review',
    command: '/review',
    summary: 'Generate review findings.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'ask',
    command: '/ask',
    summary: 'Ask a free-form question about the PR.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'improve',
    command: '/improve',
    summary: 'Generate code improvement suggestions.',
    kind: 'read',
    isRun: true,
  },
  {
    id: 'approve',
    command: '/approve',
    summary: 'Approve the PR.',
    kind: 'mutating',
    grant: 'approve',
    isRun: false,
  },
  {
    id: 'needswork',
    command: '/needswork',
    summary: 'Request changes on the PR.',
    kind: 'mutating',
    grant: 'needs_work',
    isRun: false,
  },
  {
    id: 'publish',
    command: '/publish',
    summary: 'Publish review comments to the remote.',
    kind: 'mutating',
    grant: 'publish_comment',
    isRun: false,
  },
] as const satisfies readonly ToolSpec[];

/** pr-agent run-queue tool ids (the `isRun` entries in the registry). */
export type ReviewRunTool = Extract<(typeof TOOLS)[number], { isRun: true }>['id'];

/** Set of read run-tool ids: the planning (ReAct) red line only allows these tools to be invoked autonomously, used for validation. */
export const READ_RUN_TOOL_IDS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.isRun && t.kind === 'read').map((t) => t.id),
);
