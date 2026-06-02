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
    const bridge = new LocalCliBridge('pr-agent 0.35.0', makeRecordingExec().exec);
    expect(bridge.strategy).toBe('local-cli');
    expect(bridge.version).toBe('pr-agent 0.35.0');
  });

  it('cwd 配置后切到 local-mode: --pr_url 的值是 target branch 名 (pr-agent local provider 约定)', async () => {
    const { exec, calls } = makeRecordingExec();
    const bridge = new LocalCliBridge('v', exec);
    await bridge.review({
      prUrl: 'https://x/pr/1', // 本地模式下 prUrl 不会被用到
      cwd: '/tmp/wt/abc',
      targetBranch: 'pr-pilot/base',
      env: { OPENAI_KEY: 'sk' },
    });
    expect(calls[0]!.args).toEqual(['--pr_url', 'pr-pilot/base', 'review']);
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

  it('cwd 配置后切到 local-mode: -v 挂 /workspace + -w /workspace + --pr_url = target branch 名', async () => {
    // 几个反直觉点：
    // - 挂载点是 /workspace 不是 /app —— pragent/pr-agent 容器 WORKDIR=/app 且代码
    //   在 /app/pr_agent/，挂用户 worktree 到 /app 会盖掉容器代码
    // - --entrypoint python + 绝对路径 cli.py：镜像默认 ENTRYPOINT 是相对路径，-w
    //   改了之后会找错
    // - --pr_url 的值是 TARGET BRANCH NAME，不是 URL —— local provider 把 --pr_url
    //   当 LocalGitProvider 第一个位置参数 target_branch_name
    const { exec, calls } = makeRecordingExec();
    const bridge = new DockerBridge('v', exec);
    await bridge.review({
      prUrl: 'unused-when-cwd-set',
      cwd: process.platform === 'win32' ? 'D:\\tmp\\wt\\abc' : '/tmp/wt/abc',
      targetBranch: 'pr-pilot/base',
      env: { OPENAI_KEY: 'sk' },
    });
    const expectedMount = process.platform === 'win32' ? '/d/tmp/wt/abc' : '/tmp/wt/abc';
    expect(calls[0]!.args).toEqual([
      'run',
      '--rm',
      '-e',
      'OPENAI_KEY=sk',
      '-e',
      'CONFIG__GIT_PROVIDER=local',
      '-v',
      `${expectedMount}:/workspace`,
      '-w',
      '/workspace',
      '--entrypoint',
      'python',
      'pragent/pr-agent:0.35.0',
      '/app/pr_agent/cli.py',
      '--pr_url',
      'pr-pilot/base',
      'review',
    ]);
    // docker spawn 自己仍然不带 env (token 只进容器)
    expect(calls[0]!.opts.env).toBeUndefined();
  });
});
