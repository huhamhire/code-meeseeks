import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PrAgentStatus, PrAgentStrategy } from '@meebox/shared';
import { EmbeddedRuntimeBridge, LocalCliBridge } from './bridge.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from './constants.js';
import { defaultExec } from './exec.js';
import type { ExecFn, PrAgentBridge } from './types.js';

/** Strategy choice: 'auto' detects by priority; an explicit value forces that strategy. */
export type StrategyChoice = 'auto' | PrAgentStrategy;

export interface DetectOptions {
  /**
   * Absolute path to the embedded runtime interpreter (passed in by the main process after resolving
   * dev/packaged). When given and the file exists, the 'embedded' strategy joins detection and ranks
   * first. The bridge package itself can't reach the Electron app, so the path must be injected by the caller.
   */
  embeddedPythonPath?: string;
  /** Force strategy; 'auto' (default) detects in embedded → local-cli order. */
  forceStrategy?: StrategyChoice;
}

interface ProbeOk {
  ok: true;
  version: string;
  probeMs: number;
}

interface ProbeFail {
  ok: false;
  error: string;
  probeMs: number;
}

type ProbeResult = ProbeOk | ProbeFail;

/**
 * Spawn a command, treat ANY output (even non-zero exit) as "binary exists",
 * spawn ENOENT as "binary missing". For the default timeout fallback see DEFAULT_PROBE_TIMEOUT_MS.
 */
async function exec(
  cmd: string,
  args: string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  requireZeroExit = false,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const t0 = performance.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const elapsed = (): number => Math.round(performance.now() - t0);
    const settle = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { shell: false, windowsHide: true });
    } catch (e) {
      settle({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        probeMs: elapsed(),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      settle({ ok: false, error: `timed out after ${timeoutMs}ms`, probeMs: elapsed() });
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      settle({ ok: false, error: e.message, probeMs: elapsed() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = (stdout || stderr).trim();
      const firstLine = combined.split('\n')[0]?.slice(0, 200) ?? '';
      // requireZeroExit: when a trustworthy output is needed (e.g. the pr-agent version number), exit!=0 counts as failure,
      // to avoid treating the first error line (traceback) as the result. The plain "does the binary exist" detect stays lenient (any output will do).
      if (requireZeroExit && code !== 0) {
        settle({ ok: false, error: firstLine || `exit ${String(code)}`, probeMs: elapsed() });
      } else if (combined) {
        settle({ ok: true, version: firstLine, probeMs: elapsed() });
      } else {
        settle({ ok: false, error: `no output (exit ${String(code)})`, probeMs: elapsed() });
      }
    });
  });
}

async function probeLocalCli(): Promise<ProbeResult> {
  return exec('pr-agent', ['--help']);
}

/**
 * Look up the actually installed pr-agent version in the embedded runtime (importlib.metadata, does not
 * import pr_agent, fast). On failure (not installed / interpreter error) returns null for the caller to fall back.
 */
async function embeddedPrAgentVersion(pythonPath: string): Promise<string | null> {
  const r = await exec(
    pythonPath,
    ['-c', "from importlib.metadata import version;print(version('pr-agent'))"],
    5000,
    true,
  );
  return r.ok ? r.version.trim() : null;
}

/**
 * Build the detect sequence by forceStrategy / availability. embedded only joins when pythonPath is
 * given and the file exists, and ranks first; when forceStrategy is not 'auto' only that strategy is kept.
 */
function buildStrategies(
  opts: DetectOptions,
): Array<{ name: PrAgentStrategy; probe: () => Promise<ProbeResult> }> {
  const pyPath = opts.embeddedPythonPath;
  const all: Array<{ name: PrAgentStrategy; probe: () => Promise<ProbeResult> }> = [];
  // Run `python --version` on the embedded interpreter: fast, and when the file doesn't exist it's judged unavailable outright (non-blocking)
  if (pyPath && existsSync(pyPath)) {
    all.push({ name: 'embedded', probe: () => exec(pyPath, ['--version']) });
  }
  all.push({ name: 'local-cli', probe: probeLocalCli });
  const force = opts.forceStrategy ?? 'auto';
  return force === 'auto' ? all : all.filter((s) => s.name === force);
}

/**
 * Detect pr-agent availability by priority: embedded (bundled with the app) → local CLI (pipx).
 * Returns the first successful strategy; if all fail, reports all attempt results.
 */
export async function detectPrAgent(opts: DetectOptions = {}): Promise<PrAgentStatus> {
  const strategies = buildStrategies(opts);
  const failed: Array<{ strategy: PrAgentStrategy; error: string; probeMs: number }> = [];
  for (const { name, probe } of strategies) {
    const r = await probe();
    if (r.ok) {
      // Semantics of the version field: the "pr-agent version" the user sees in the UI.
      // - embedded: separately queries importlib.metadata to get the actually installed pr-agent version (`pr-agent 0.36.0`),
      //   rather than the interpreter's Python version (what the user cares about is the pr-agent version)
      // - local-cli: the first line of `pr-agent --help`, kept as-is
      let version: string;
      if (name === 'embedded') {
        const pv = opts.embeddedPythonPath
          ? await embeddedPrAgentVersion(opts.embeddedPythonPath)
          : null;
        version = `pr-agent ${pv ?? 'unknown'}`;
      } else {
        version = r.version;
      }
      return { available: true, strategy: name, version, probeMs: r.probeMs };
    }
    failed.push({ strategy: name, error: r.error, probeMs: r.probeMs });
  }
  return { available: false, attempts: failed };
}

/**
 * Detect and construct a callable PrAgentBridge. embedded takes priority (requires passing embeddedPythonPath) →
 * LocalCli; when neither is available returns null + status (the UI shows the unavailable placeholder).
 * ExecFn can be injected for unit tests / mocking.
 */
export async function createPrAgentBridge(
  opts: DetectOptions & { exec?: ExecFn } = {},
): Promise<{ bridge: PrAgentBridge | null; status: PrAgentStatus }> {
  const status = await detectPrAgent(opts);
  if (!status.available) return { bridge: null, status };
  const exec = opts.exec ?? defaultExec;
  // When detectPrAgent picks embedded, embeddedPythonPath is guaranteed to exist (buildStrategies already validated it)
  const bridge: PrAgentBridge =
    status.strategy === 'embedded'
      ? new EmbeddedRuntimeBridge(status.version, opts.embeddedPythonPath!, exec)
      : new LocalCliBridge(status.version, exec);
  return { bridge, status };
}
