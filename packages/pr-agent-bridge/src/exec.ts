import { spawn, type SpawnOptions } from 'node:child_process';
import treeKill from 'tree-kill';
import { PrAgentRunError, type ExecFn, type PrAgentRunResult } from './types.js';

/** Minimal dependency slice of the spawn function, to ease injecting a fake in tests */
export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => SpawnedChild;

interface DataEmitter {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

interface WritableLike {
  write(chunk: string): unknown;
  end(): unknown;
}

interface SpawnedChild {
  /** Subprocess pid; undefined when spawn fails. Used by the caller for process-tree-level cleanup. */
  pid?: number;
  stdout: DataEmitter | null;
  stderr: DataEmitter | null;
  /** Subprocess stdin; written then ended when opts.input is set. May be null on spawn failure / fake child. */
  stdin?: WritableLike | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Kill the **entire process tree** of the subprocess. pr-agent's python further spawns grandchildren
 * like litellm / network libraries; on Windows `child.kill` does not cascade — it only kills the python
 * main process, leaving grandchildren orphaned and still holding file handles on vendor/python etc.,
 * causing the NSIS installer to report "application cannot close" during upgrade. tree-kill on win32 is
 * native `taskkill /pid X /T /F` (cascades, no dependency on wmic which Win11 removed); posix walks the
 * process tree via ps. When there is no pid (spawn failure / test fake child), fall back to a direct kill.
 */
function killTree(child: SpawnedChild): void {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    return;
  }
  treeKill(pid, 'SIGKILL', () => {
    // tree-kill failure fallback: at least kill the direct subprocess
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  });
}

/**
 * Construct an ExecFn. spawnFn defaults to node:child_process.spawn; inject a fake in tests.
 *
 * Behavior:
 * - Launch failure (ENOENT etc.) → reject(PrAgentRunError 'spawn-failed')
 * - Timeout → SIGKILL subprocess + reject(PrAgentRunError 'timeout'); the collected stdout / stderr
 *   are returned along with the result
 * - Non-zero exit code / killed by signal → reject(PrAgentRunError 'non-zero-exit' / 'killed')
 * - onLine fires in real time split by \n; any leftover partial line is also emitted once at process end
 */
export function createExec(spawnFn: SpawnFn = spawn as unknown as SpawnFn): ExecFn {
  return (cmd, args, opts) => {
    return new Promise<PrAgentRunResult>((resolve, reject) => {
      const t0 = Date.now();
      const elapsed = (): number => Date.now() - t0;

      let stdout = '';
      let stderr = '';
      let stdoutBuf = '';
      let stderrBuf = '';
      let killedByTimeout = false;
      let cancelled = false;
      let settled = false;

      let child: SpawnedChild;
      try {
        child = spawnFn(cmd, args, {
          shell: false,
          windowsHide: true,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          cwd: opts.cwd,
        });
      } catch (e) {
        reject(
          new PrAgentRunError(
            `spawn ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`,
            'spawn-failed',
            { durationMs: elapsed() },
          ),
        );
        return;
      }

      // Write input such as the prompt into the subprocess stdin (used by the chat channel); end after
      // writing to trigger EOF.
      if (opts.input != null) {
        try {
          child.stdin?.write(opts.input);
          child.stdin?.end();
        } catch {
          /* stdin already closed / subprocess already exited, ignore */
        }
      }

      const timer = setTimeout(() => {
        killedByTimeout = true;
        killTree(child);
      }, opts.timeoutMs);

      // User cancellation: listen on AbortSignal, trigger SIGKILL; also handle a signal already aborted before we received it
      const onAbort = (): void => {
        if (settled) return;
        cancelled = true;
        killTree(child);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          // Defensive: caller passed in an already-aborted signal → kill immediately
          queueMicrotask(onAbort);
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stream === 'stdout') stdout += s;
        else stderr += s;
        if (!opts.onLine) return;
        let buf = stream === 'stdout' ? stdoutBuf + s : stderrBuf + s;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          // Strip a possible trailing \r
          let line = buf.slice(0, nl);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          opts.onLine(line, stream);
          buf = buf.slice(nl + 1);
        }
        if (stream === 'stdout') stdoutBuf = buf;
        else stderrBuf = buf;
      };

      child.stdout?.on('data', onData('stdout'));
      child.stderr?.on('data', onData('stderr'));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(
          new PrAgentRunError(err.message, 'spawn-failed', {
            stdout,
            stderr,
            durationMs: elapsed(),
          }),
        );
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        // Emit any leftover partial line as well
        if (opts.onLine) {
          if (stdoutBuf) opts.onLine(stdoutBuf, 'stdout');
          if (stderrBuf) opts.onLine(stderrBuf, 'stderr');
        }
        const result: PrAgentRunResult = {
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: elapsed(),
        };
        // Cancellation has highest priority: a signal kill caused by cancellation is not counted as timeout / killed / non-zero-exit
        if (cancelled) {
          reject(new PrAgentRunError('pr-agent cancelled by user', 'cancelled', result));
          return;
        }
        if (killedByTimeout) {
          reject(
            new PrAgentRunError(
              `pr-agent timed out after ${String(opts.timeoutMs)}ms`,
              'timeout',
              result,
            ),
          );
          return;
        }
        if (signal) {
          reject(
            new PrAgentRunError(`pr-agent killed by signal ${signal}`, 'killed', result),
          );
          return;
        }
        if ((code ?? 0) !== 0) {
          reject(
            new PrAgentRunError(
              `pr-agent exited with code ${String(code)}`,
              'non-zero-exit',
              result,
            ),
          );
          return;
        }
        resolve(result);
      });
    });
  };
}

/** Default ExecFn: goes through node:child_process.spawn */
export const defaultExec: ExecFn = createExec();
