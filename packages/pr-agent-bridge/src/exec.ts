import { spawn, type SpawnOptions } from 'node:child_process';
import treeKill from 'tree-kill';
import { PrAgentRunError, type ExecFn, type PrAgentRunResult } from './types.js';

/** spawn 函数的最小依赖切片，便于测试注入 fake */
export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => SpawnedChild;

interface DataEmitter {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}

interface SpawnedChild {
  /** 子进程 pid；spawn 失败时为 undefined。用于调用方做进程树级清理。 */
  pid?: number;
  stdout: DataEmitter | null;
  stderr: DataEmitter | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * 杀掉子进程的**整棵进程树**。pr-agent 的 python 会再 spawn litellm/网络库等孙进程，
 * Windows 下 `child.kill` 不级联——只杀 python 主进程，孙进程变孤儿继续占着 vendor/python
 * 等文件句柄，导致升级时 NSIS 安装器报「应用无法关闭」。tree-kill 在 win32 即原生
 * `taskkill /pid X /T /F`（级联、不依赖已被 Win11 移除的 wmic）；posix 走 ps 遍历进程树。
 * 无 pid（spawn 失败 / 测试 fake child）时回退直接 kill。
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
    // tree-kill 失败兜底：至少杀掉直接子进程
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  });
}

/**
 * 构造一个 ExecFn。spawnFn 默认 node:child_process.spawn；测试时注入 fake。
 *
 * 行为：
 * - 启动失败 (ENOENT 等) → reject(PrAgentRunError 'spawn-failed')
 * - 超时 → SIGKILL 子进程 + reject(PrAgentRunError 'timeout')，已收集的 stdout / stderr
 *   随 result 一起返回
 * - 退出码非 0 / 被信号杀 → reject(PrAgentRunError 'non-zero-exit' / 'killed')
 * - onLine 按 \n 切片实时回调；进程结束时残留 partial line 也补一次
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

      const timer = setTimeout(() => {
        killedByTimeout = true;
        killTree(child);
      }, opts.timeoutMs);

      // 用户取消：监听 AbortSignal，触发 SIGKILL；signal 在我们入参前就 aborted 也兜住
      const onAbort = (): void => {
        if (settled) return;
        cancelled = true;
        killTree(child);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          // 防御：调用方传进来已经 abort 的 signal → 立即杀
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
          // 去掉行尾可能的 \r
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
        // 把残留的 partial line 也吐出来
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
        // 取消优先级最高：取消导致的信号杀掉，不算 timeout / killed / non-zero-exit
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

/** 默认 ExecFn：走 node:child_process.spawn */
export const defaultExec: ExecFn = createExec();
