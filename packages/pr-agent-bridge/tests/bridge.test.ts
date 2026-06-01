import { describe, expect, it, vi } from 'vitest';
import { DockerBridge, LocalCliBridge } from '../src/bridge.js';
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
    const bridge = new LocalCliBridge('pr-agent 0.35.0', exec);
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

  it('未给 timeoutMs 时落到默认 5 min', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1' });
    expect(calls[0]!.opts.timeoutMs).toBe(5 * 60 * 1000);
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
    const bridge = new LocalCliBridge('pr-agent 0.35.0', makeRecordingExec().exec);
    expect(bridge.strategy).toBe('local-cli');
    expect(bridge.version).toBe('pr-agent 0.35.0');
  });
});

describe('DockerBridge', () => {
  it('默认镜像 pinned 到 pragent/pr-agent:0.35.0', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('docker v25', exec);
    await bridge.describe({ prUrl: 'https://x/pr/1' });
    expect(calls[0]!.cmd).toBe('docker');
    expect(calls[0]!.args).toEqual([
      'run',
      '--rm',
      'pragent/pr-agent:0.35.0',
      '--pr_url',
      'https://x/pr/1',
      'describe',
    ]);
  });

  it('env 翻成 -e KEY=VAL（多条按 entry 顺序展开）', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('v', exec);
    await bridge.review({
      prUrl: 'https://x/pr/1',
      env: { OPENAI_KEY: 'sk-test', PR_PILOT_MODEL: 'gpt-4o' },
    });
    expect(calls[0]!.args).toEqual([
      'run',
      '--rm',
      '-e',
      'OPENAI_KEY=sk-test',
      '-e',
      'PR_PILOT_MODEL=gpt-4o',
      'pragent/pr-agent:0.35.0',
      '--pr_url',
      'https://x/pr/1',
      'review',
    ]);
  });

  it('docker spawn 自己不带 env（token 只进容器）', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('v', exec);
    await bridge.review({ prUrl: 'https://x/pr/1', env: { OPENAI_KEY: 'sk' } });
    expect(calls[0]!.opts.env).toBeUndefined();
  });

  it('支持自定义镜像（pinning 升级 / 自建镜像）', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('v', exec, 'internal/pr-agent:0.40.0');
    await bridge.describe({ prUrl: 'https://x/pr/1' });
    expect(calls[0]!.args[2]).toBe('internal/pr-agent:0.40.0');
  });

  it('extraArgs 追加到 tool 之后', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('v', exec);
    await bridge.review({ prUrl: 'https://x/pr/1', extraArgs: ['--my_flag'] });
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe('--my_flag');
    expect(calls[0]!.args[calls[0]!.args.length - 2]).toBe('review');
  });
});
