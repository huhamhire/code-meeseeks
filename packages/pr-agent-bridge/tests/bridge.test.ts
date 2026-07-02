import { describe, expect, it, vi } from 'vitest';
import { EmbeddedRuntimeBridge, LocalCliBridge } from '../src/bridge.js';
import type { ExecFn, ExecOptions, PrAgentRunResult } from '../src/types.js';

/** 收集所有 exec 调用便于断言 cmd / args / env / timeoutMs */
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
  it('describe 走 pr-agent --pr_url <url> describe', async () => {
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

  it('review 末尾追加 extraArgs', async () => {
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

  it('env 通过 exec opts.env 透传（LocalCli 由 exec 层 merge process.env）', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({ prUrl: 'https://x/pr/1', env: { OPENAI_KEY: 'sk-test' } });
    expect(calls[0]!.opts.env).toEqual({ OPENAI_KEY: 'sk-test' });
  });

  it('未给 timeoutMs 时落到默认 10 min', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1' });
    expect(calls[0]!.opts.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('显式 timeoutMs 覆盖默认值', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1', timeoutMs: 30_000 });
    expect(calls[0]!.opts.timeoutMs).toBe(30_000);
  });

  it('onLine 透传给 exec', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    const onLine = vi.fn();
    await bridge.review({ prUrl: 'https://x/pr/1', onLine });
    expect(calls[0]!.opts.onLine).toBe(onLine);
  });

  it('strategy + version 暴露', () => {
    const bridge = new LocalCliBridge('pr-agent 0.36.0', makeRecordingExec().exec);
    expect(bridge.strategy).toBe('local-cli');
    expect(bridge.version).toBe('pr-agent 0.36.0');
  });

  it('cwd 配置后切到 local-mode: --pr_url 的值是 target branch 名 (pr-agent local provider 约定)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({
      prUrl: 'https://x/pr/1', // 本地模式下 prUrl 不会被用到
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

  it('local-mode 无 targetBranch: --pr_url 留空 (调用方应保证传)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({ prUrl: 'unused', cwd: '/tmp/wt' });
    expect(calls[0]!.args).toEqual(['--pr_url', '', 'review']);
    expect(calls[0]!.opts.env).toEqual({ CONFIG__GIT_PROVIDER: 'local' });
  });

  it('chat: local-cli 不支持，调用即抛错（无嵌入式运行时）', async () => {
    const bridge = new LocalCliBridge('v', makeRecordingExec().exec);
    await expect(bridge.chat({ user: 'hi' })).rejects.toThrow(/嵌入式/);
  });
});

describe('EmbeddedRuntimeBridge', () => {
  const PY = '/app/vendor/pragent/python/bin/python3';

  it('local-mode: 用嵌入式解释器 -m pr_agent.cli + target branch + local provider', async () => {
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

  it('extraArgs 追加在末尾', async () => {
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

  it('strategy + version 暴露', () => {
    const bridge = new EmbeddedRuntimeBridge('embedded Python 3.12.13', PY, makeRecordingExec().exec);
    expect(bridge.strategy).toBe('embedded');
    expect(bridge.version).toBe('embedded Python 3.12.13');
  });

  it('chat: 跑 meebox_pragent_shim.chat，prompt 走 stdin，UTF-8 + 中性 cwd', async () => {
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

  it('chat: temperature 仅在显式传入时进 payload', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new EmbeddedRuntimeBridge('v', PY, exec);
    await bridge.chat({ user: 'hi', temperature: 0.7 });
    expect(JSON.parse(calls[0]!.opts.input!)).toEqual({ system: '', user: 'hi', temperature: 0.7 });
  });
});
