import type { PrAgentStrategy } from '@meebox/shared';

/** pr-agent subcommand enum; same set as @meebox/shared's ReviewRunTool */
export type PrAgentTool = 'describe' | 'review' | 'ask' | 'improve';

export interface PrAgentRunOptions {
  /**
   * pr-agent entry `--pr_url`.
   * - Remote mode: Bitbucket PR URL, e.g. https://host/projects/.../pull-requests/<id>
   * - Local mode (cwd configured): pass the cwd path directly (fixed to /repo in the container), which
   *   pr-agent uses to locate the local repository directory, without hitting any remote API
   */
  prUrl: string;
  tool: PrAgentTool;
  /** Environment variables injected into the subprocess (LLM key / platform token / config overrides) */
  env?: Record<string, string>;
  /** Arguments appended at the end of the CLI (e.g. --extra_instructions / --config_file) */
  extraArgs?: string[];
  /** Timeout for a single call, default 5 min */
  timeoutMs?: number;
  /** Per-line streaming push of stdout / stderr (for M3-B UI progress hints) */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * User-initiated cancellation signal. After abort, SIGKILL the subprocess and reject with
   * PrAgentRunError reason='cancelled'. If not passed, never cancels, with only timeoutMs as a fallback.
   */
  signal?: AbortSignal;
  /**
   * Absolute path of the local worktree. When configured, switches to `git_provider=local` mode: uses cwd
   * as the subprocess working directory, and pr-agent runs `git diff <targetBranch>...HEAD` itself, never
   * going out to the code host. If not set, uses the original remote provider mode (default: pull the PR
   * from the remote via prUrl).
   */
  cwd?: string;
  /**
   * Local diff starting point. Effective only when `cwd` is set; typical value is the PR base sha or ref name.
   * Passed to pr-agent's `--target_branch`; when omitted, pr-agent falls back to the default branch itself.
   */
  targetBranch?: string;
}

export interface PrAgentRunResult {
  /** Full stdout text of the subprocess */
  stdout: string;
  /** Full stderr text of the subprocess */
  stderr: string;
  /** Exit code; -1 when killed by signal / launch failed */
  exitCode: number;
  /** Wall-clock run time (ms) */
  durationMs: number;
}

export type PrAgentRunFailureReason =
  /** SIGKILLed on timeout */
  | 'timeout'
  /** Subprocess failed to launch (ENOENT / permission / fork failure) */
  | 'spawn-failed'
  /** Exited normally but exit code != 0 */
  | 'non-zero-exit'
  /** Killed by an external signal (not a timeout) */
  | 'killed'
  /** User-initiated cancellation (AbortSignal abort) */
  | 'cancelled';

/** Thrown when pr-agent run fails; carries the reason + collected stdout / stderr / exitCode for UI display */
export class PrAgentRunError extends Error {
  constructor(
    message: string,
    public readonly reason: PrAgentRunFailureReason,
    public readonly result: Partial<PrAgentRunResult> = {},
  ) {
    super(message);
    this.name = 'PrAgentRunError';
  }
}

export interface ExecOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Subprocess working directory; used in local mode */
  cwd?: string;
  /** User-initiated cancellation signal; after abort, SIGKILL the subprocess and reject reason='cancelled' */
  signal?: AbortSignal;
  /** Content written to the subprocess stdin (ended after writing); used by the chat channel to pass the prompt. */
  input?: string;
}

/**
 * A single raw dialogue call of the orchestrator's "standalone LLM channel" (see
 * docs/arch/02-agent/02-session.md "Session Agentification"). Reuses the embedded runtime's litellm
 * (provider routing / proxy / token collection already solved): the subprocess runs
 * `meebox_pragent_shim.chat`, the prompt is passed via stdin, the result goes through stdout, and token
 * usage is printed to stderr via the `@@MEEBOX_USAGE@@` sentinel (the same setup as pr-agent run).
 */
export interface ChatRunOptions {
  /** system section (nullable). */
  system?: string;
  /** user section (required). */
  user: string;
  /** Sampling temperature; automatically stripped for anthropic via the shim. */
  temperature?: number;
  /**
   * Output token cap (litellm max_tokens). Used to cap output for lightweight routing judgments (e.g.
   * follow-up judgment), avoiding the model spewing large amounts of tokens for a yes/no decision and
   * slowing the response. Effective only on the embedded litellm path; ignored by the CLI provider.
   * Omitted = no cap (not passed for those needing full length, e.g. summarization / planning wrap-up).
   */
  maxOutputTokens?: number;
  /** env injected into the subprocess (LLM key / model / proxy, reuses buildPragentEnv). */
  env?: Record<string, string>;
  /** Subprocess working directory; recommended to pass a neutral temp directory (in cli mode, to avoid picking up the reviewed repo's CLAUDE.md). */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Injectable subprocess exec interface: the default implementation goes through node:child_process.spawn,
 * and unit tests can inject a fake version without depending on a real Node subprocess. The Bridge layer
 * does not import spawn directly, only depending on this interface.
 */
export type ExecFn = (cmd: string, args: string[], opts: ExecOptions) => Promise<PrAgentRunResult>;

export interface PrAgentBridge {
  /** The selected strategy name after resolution */
  readonly strategy: PrAgentStrategy;
  /** Version string obtained during detection (CLI --help / --version first line, or the pr-agent version discovered by the embedded runtime) */
  readonly version: string;
  /** Run /describe; equivalent to run({ ...opts, tool: 'describe' }) */
  describe(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** Run /review; equivalent to run({ ...opts, tool: 'review' }) */
  review(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** Generic entry; use run directly when adding /ask /improve later */
  run(opts: PrAgentRunOptions): Promise<PrAgentRunResult>;
  /**
   * The orchestrator's standalone LLM dialogue channel (reuses the embedded litellm, see ChatRunOptions).
   * Supported only by the embedded strategy; the local-cli strategy throws on call. Result stdout = reply
   * text, stderr contains the `@@MEEBOX_USAGE@@` token sentinel (accumulated by the caller via the existing parser).
   */
  chat(opts: ChatRunOptions): Promise<PrAgentRunResult>;
}
