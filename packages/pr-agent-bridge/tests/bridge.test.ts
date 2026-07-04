import { describe, expect, it, vi } from 'vitest';
import { EmbeddedRuntimeBridge, LocalCliBridge } from '../src/bridge.js';
import type { ExecFn, ExecOptions, PrAgentRunResult } from '../src/types.js';

/** Collect all exec calls to ease asserting cmd / args / env / timeoutMs */
function makeRecordingExec(returnValue?: Partial<PrAgentRunResult>): {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: string[]; opts: ExecOptions }>;
} {
  const calls: Array<{ cmd: string; args: string[]; opts: ExecOptions }> = [];
  const exec: ExecFn = vi.fn((cmd: string, args: string[], opts: ExecOptions) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve<PrAgentRunResult>({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      ...returnValue,
    });
  });
  return { exec, calls };
}

describe('LocalCliBridge', () => {
  it('describe goes through pr-agent --pr_url <url> describe', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('pr-agent 0.36.0', exec);
    await bridge.describe({ prUrl: 'https://bb/projects/X/repos/y/pull-requests/1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('pr-agent');
    expect(calls[0]!.args).toEqual([
      '--pr_url',
      'https://bb/projects/X/repos/y/pull-requests/1',
      'describe',
    ]);
  });

  it('review appends extraArgs at the end', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({
      prUrl: 'https://x/pr/1',
      extraArgs: ['--config_file', '/tmp/c.toml'],
    });
    expect(calls[0]!.args).toEqual([
      '--pr_url',
      'https://x/pr/1',
      'review',
      '--config_file',
      '/tmp/c.toml',
    ]);
  });

  it('env is passed through via exec opts.env (LocalCli merges process.env at the exec layer)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({ prUrl: 'https://x/pr/1', env: { OPENAI_KEY: 'sk-test' } });
    expect(calls[0]!.opts.env).toEqual({ OPENAI_KEY: 'sk-test' });
  });

  it('falls to the default 10 min when timeoutMs is not given', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1' });
    expect(calls[0]!.opts.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('explicit timeoutMs overrides the default', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1', timeoutMs: 30_000 });
    expect(calls[0]!.opts.timeoutMs).toBe(30_000);
  });

  it('onLine is passed through to exec', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    const onLine = vi.fn();
    await bridge.review({ prUrl: 'https://x/pr/1', onLine });
    expect(calls[0]!.opts.onLine).toBe(onLine);
  });

  it('strategy + version are exposed', () => {
    const bridge = new LocalCliBridge('pr-agent 0.36.0', makeRecordingExec().exec);
    expect(bridge.strategy).toBe('local-cli');
    expect(bridge.version).toBe('pr-agent 0.36.0');
  });

  it('after cwd is configured, switches to local-mode: --pr_url value is the target branch name (pr-agent local provider convention)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({
      prUrl: 'https://x/pr/1', // in local mode prUrl is not used
      cwd: '/tmp/wt/abc',
      targetBranch: 'pr-abc123/base',
      env: { OPENAI_KEY: 'sk' },
    });
    expect(calls[0]!.args).toEqual(['--pr_url', 'pr-abc123/base', 'review']);
    expect(calls[0]!.opts.cwd).toBe('/tmp/wt/abc');
    expect(calls[0]!.opts.env).toEqual({
      OPENAI_KEY: 'sk',
      CONFIG__GIT_PROVIDER: 'local',
    });
  });

  it('local-mode without targetBranch: --pr_url left empty (caller should guarantee passing it)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({ prUrl: 'unused', cwd: '/tmp/wt' });
    expect(calls[0]!.args).toEqual(['--pr_url', '', 'review']);
    expect(calls[0]!.opts.env).toEqual({ CONFIG__GIT_PROVIDER: 'local' });
  });

  it('chat: local-cli is not supported, throws on call (no embedded runtime)', async () => {
    const bridge = new LocalCliBridge('v', makeRecordingExec().exec);
    await expect(bridge.chat({ user: 'hi' })).rejects.toThrow(/嵌入式/);
  });
});

describe('EmbeddedRuntimeBridge', () => {
  const PY = '/app/vendor/pragent/python/bin/python3';

  it('local-mode: uses the embedded interpreter -m pr_agent.cli + target branch + local provider', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new EmbeddedRuntimeBridge('embedded Python 3.12.13', PY, exec);
    await bridge.review({
      prUrl: 'unused',
      cwd: '/tmp/wt/abc',
      targetBranch: 'pr-abc123/base',
      env: { OPENAI__KEY: 'sk' },
    });
    expect(calls[0]!.cmd).toBe(PY);
    expect(calls[0]!.args).toEqual([
      '-m',
      'pr_agent.cli',
      '--pr_url',
      'pr-abc123/base',
      'review',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/tmp/wt/abc');
    expect(calls[0]!.opts.env).toEqual({
      OPENAI__KEY: 'sk',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      CONFIG__GIT_PROVIDER: 'local',
    });
  });

  it('extraArgs are appended at the end', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new EmbeddedRuntimeBridge('v', PY, exec);
    await bridge.review({
      prUrl: 'unused',
      cwd: '/tmp/wt',
      targetBranch: 'base',
      extraArgs: ['--config_file', '/tmp/c.toml'],
    });
    expect(calls[0]!.args).toEqual([
      '-m',
      'pr_agent.cli',
      '--pr_url',
      'base',
      'review',
      '--config_file',
      '/tmp/c.toml',
    ]);
  });

  it('strategy + version are exposed', () => {
    const bridge = new EmbeddedRuntimeBridge('embedded Python 3.12.13', PY, makeRecordingExec().exec);
    expect(bridge.strategy).toBe('embedded');
    expect(bridge.version).toBe('embedded Python 3.12.13');
  });

  it('chat: runs meebox_pragent_shim.chat, prompt goes through stdin, UTF-8 + neutral cwd', async () => {
    const { exec, calls } = makeRecordingExec({ stdout: 'reply' });
    const bridge = new EmbeddedRuntimeBridge('v', PY, exec);
    const res = await bridge.chat({
      system: 'sys',
      user: 'hi',
      env: { OPENAI__KEY: 'sk' },
      cwd: '/tmp/neutral',
    });
    expect(res.stdout).toBe('reply');
    expect(calls[0]!.cmd).toBe(PY);
    expect(calls[0]!.args).toEqual(['-m', 'meebox_pragent_shim.chat']);
    expect(calls[0]!.opts.cwd).toBe('/tmp/neutral');
    expect(calls[0]!.opts.env).toEqual({
      OPENAI__KEY: 'sk',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    });
    expect(JSON.parse(calls[0]!.opts.input!)).toEqual({ system: 'sys', user: 'hi' });
    expect(calls[0]!.opts.timeoutMs).toBe(5 * 60 * 1000);
  });

  it('chat: temperature enters the payload only when explicitly passed', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new EmbeddedRuntimeBridge('v', PY, exec);
    await bridge.chat({ user: 'hi', temperature: 0.7 });
    expect(JSON.parse(calls[0]!.opts.input!)).toEqual({ system: '', user: 'hi', temperature: 0.7 });
  });
});
