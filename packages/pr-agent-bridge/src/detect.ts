import { spawn } from 'node:child_process';
import type { PrAgentStatus, PrAgentStrategy } from '@pr-pilot/shared';
import { DEFAULT_DOCKER_IMAGE_TAG, DockerBridge, LocalCliBridge } from './bridge.js';
import { defaultExec } from './exec.js';
import type { ExecFn, PrAgentBridge } from './types.js';

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
 * spawn ENOENT as "binary missing". 5s 超时兜底。
 */
async function exec(cmd: string, args: string[], timeoutMs = 5000): Promise<ProbeResult> {
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
      if (combined) {
        const firstLine = combined.split('\n')[0]?.slice(0, 200) ?? '';
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

async function probeDocker(): Promise<ProbeResult> {
  return exec('docker', ['--version']);
}

const STRATEGIES: ReadonlyArray<{ name: PrAgentStrategy; probe: () => Promise<ProbeResult> }> = [
  { name: 'local-cli', probe: probeLocalCli },
  { name: 'docker', probe: probeDocker },
];

/**
 * 按优先级探测 pr-agent 可用性：先 local CLI (pipx 安装的)，再 Docker。
 * 返回首个成功的策略；全部失败则报告所有尝试结果。
 */
export async function detectPrAgent(): Promise<PrAgentStatus> {
  const failed: Array<{ strategy: PrAgentStrategy; error: string; probeMs: number }> = [];
  for (const { name, probe } of STRATEGIES) {
    const r = await probe();
    if (r.ok) {
      // version 字段语义：用户在 UI 看到的"pr-agent 版本"。
      // - docker 策略：probe 拿到的是 docker daemon 版本 (`Docker version 25.x`)，
      //   跟 pr-agent 镜像本身无关；这里改成我们 pin 的 image tag (`pragent/pr-agent:0.36.0`)，
      //   StatusBar 显示更有意义
      // - local-cli 策略：probe 拿到的是 `pr-agent --help` 首行 (通常是 usage 提示)，
      //   不是版本号但也是用户能识别的信息，保持原值。
      const version =
        name === 'docker'
          ? `pragent/pr-agent:${DEFAULT_DOCKER_IMAGE_TAG}`
          : r.version;
      return {
        available: true,
        strategy: name,
        version,
        probeMs: r.probeMs,
      };
    }
    failed.push({ strategy: name, error: r.error, probeMs: r.probeMs });
  }
  return { available: false, attempts: failed };
}

/**
 * 探测并构造一个可调用的 PrAgentBridge。LocalCli 优先 Docker fallback；都不可用
 * 时返回 null + status (UI 走 unavailable 占位)。可注入 ExecFn 便于单测 / mock。
 */
export async function createPrAgentBridge(opts?: {
  exec?: ExecFn;
}): Promise<{ bridge: PrAgentBridge | null; status: PrAgentStatus }> {
  const status = await detectPrAgent();
  if (!status.available) return { bridge: null, status };
  const exec = opts?.exec ?? defaultExec;
  const bridge: PrAgentBridge =
    status.strategy === 'local-cli'
      ? new LocalCliBridge(status.version, exec)
      : new DockerBridge(status.version, exec);
  return { bridge, status };
}
