import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createExec, type SpawnFn } from '../src/exec.js';
import { PrAgentRunError } from '../src/types.js';

/**
 * 极薄 fake spawn：返回一个 EventEmitter-like child，测试主动 emit data/close/error。
 * stdout/stderr 是分开的 emitter，子进程层只听 'data'。
 */
function fakeChild(): {
  stdout: EventEmitter;
  stderr: EventEmitter;
  ctl: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  emitData: (stream: 'stdout' | 'stderr', chunk: string) => void;
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  emitError: (err: Error) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const ctl = new EventEmitter();
  const kill = vi.fn();
  return {
    stdout,
    stderr,
    ctl,
    kill,
    emitData(stream, chunk) {
      (stream === 'stdout' ? stdout : stderr).emit('data', chunk);
    },
    emitClose(code, signal = null) {
      ctl.emit('close', code, signal);
    },
    emitError(err) {
      ctl.emit('error', err);
    },
  };
}

function buildSpawn(child: ReturnType<typeof fakeChild>): SpawnFn {
  return () =>
    ({
      stdout: child.stdout,
      stderr: child.stderr,
      on: (event: 'error' | 'close', cb: (...args: unknown[]) => void) => child.ctl.on(event, cb),
      kill: child.kill,
    }) as unknown as ReturnType<SpawnFn>;
}

describe('createExec', () => {
  it('正常 exit 0 → resolve 带 stdout / stderr / exitCode / durationMs', async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const promise = exec('pr-agent', ['--help'], { timeoutMs: 1000 });
    child.emitData('stdout', 'hello\n');
    child.emitData('stderr', 'warn\n');
    child.emitClose(0);
    const r = await promise;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('warn\n');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('非零 exit → reject(PrAgentRunError "non-zero-exit") 携带已收集输出', async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const promise = exec('pr-agent', [], { timeoutMs: 1000 });
    child.emitData('stderr', 'config missing\n');
    child.emitClose(2);
    await expect(promise).rejects.toMatchObject({
      name: 'PrAgentRunError',
      reason: 'non-zero-exit',
      result: { exitCode: 2, stderr: 'config missing\n' },
    });
  });

  it('信号杀（非超时）→ reason "killed"', async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const promise = exec('pr-agent', [], { timeoutMs: 5000 });
    child.emitClose(null, 'SIGTERM');
    await expect(promise).rejects.toMatchObject({
      name: 'PrAgentRunError',
      reason: 'killed',
    });
  });

  it('超时触发 SIGKILL 并 reject reason "timeout"', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const promise = exec('pr-agent', [], { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // exec 在 close 之后才 settle；模拟内核响应 SIGKILL 后 close
    child.emitClose(null, 'SIGKILL');
    await expect(promise).rejects.toMatchObject({
      name: 'PrAgentRunError',
      reason: 'timeout',
    });
    vi.useRealTimers();
  });

  it("'error' 事件 (spawn ENOENT) → reason \"spawn-failed\"", async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const promise = exec('not-exists', [], { timeoutMs: 1000 });
    child.emitError(new Error('spawn not-exists ENOENT'));
    await expect(promise).rejects.toMatchObject({
      name: 'PrAgentRunError',
      reason: 'spawn-failed',
    });
  });

  it('spawnFn throw → 立即 reject reason "spawn-failed"', async () => {
    const exec = createExec(() => {
      throw new Error('boom');
    });
    await expect(exec('x', [], { timeoutMs: 1000 })).rejects.toMatchObject({
      reason: 'spawn-failed',
    });
  });

  it('onLine 按 \\n 切片实时回调；尾部 partial 在 close 时补一次', async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const lines: Array<[string, string]> = [];
    const promise = exec('x', [], {
      timeoutMs: 1000,
      onLine: (line, stream) => lines.push([stream, line]),
    });
    child.emitData('stdout', 'line one\nline two\npartial');
    child.emitData('stderr', 'err one\n');
    child.emitClose(0);
    await promise;
    expect(lines).toEqual([
      ['stdout', 'line one'],
      ['stdout', 'line two'],
      ['stderr', 'err one'],
      ['stdout', 'partial'],
    ]);
  });

  it('onLine 兼容 \\r\\n 行尾（Windows 输出）', async () => {
    const child = fakeChild();
    const exec = createExec(buildSpawn(child));
    const lines: string[] = [];
    const promise = exec('x', [], {
      timeoutMs: 1000,
      onLine: (l) => lines.push(l),
    });
    child.emitData('stdout', 'win line\r\nnext\r\n');
    child.emitClose(0);
    await promise;
    expect(lines).toEqual(['win line', 'next']);
  });

  it('PrAgentRunError 是 Error 子类', () => {
    const e = new PrAgentRunError('x', 'timeout');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PrAgentRunError');
    expect(e.reason).toBe('timeout');
  });
});
