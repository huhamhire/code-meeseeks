import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PrAgentStatus, PrAgentStrategy } from '@pr-pilot/shared';
import {
  DEFAULT_DOCKER_IMAGE_TAG,
  DockerBridge,
  EmbeddedRuntimeBridge,
  LocalCliBridge,
} from './bridge.js';
import { defaultExec } from './exec.js';
import type { ExecFn, PrAgentBridge } from './types.js';

/** 策略选择：'auto' 按优先级探测；显式值强制该策略。 */
export type StrategyChoice = 'auto' | PrAgentStrategy;

export interface DetectOptions {
  /**
   * 嵌入式运行时解释器绝对路径（main 进程按 dev/打包解析后传入）。给定且文件存在
   * 时，'embedded' 策略参与探测并排在最前。bridge 包自身拿不到 Electron app，
   * 所以路径必须由调用方注入。
   */
  embeddedPythonPath?: string;
  /** 强制策略；'auto'（默认）按 embedded → local-cli → docker 顺序探测。 */
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
 * spawn ENOENT as "binary missing". 5s 超时兜底。
 */
async function exec(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
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
      // requireZeroExit：需要拿可信输出（如 pr-agent 版本号）时，exit!=0 视为失败，
      // 避免把报错首行（traceback）当成结果。普通"二进制是否存在"探测仍宽容（任意输出即可）。
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

async function probeDocker(): Promise<ProbeResult> {
  return exec('docker', ['--version']);
}

/**
 * 查嵌入式运行时里实际安装的 pr-agent 版本（importlib.metadata，不 import pr_agent，
 * 快）。失败（未装 / 解释器异常）返回 null，调用方兜底。
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
 * 按 forceStrategy / 可用性构造探测序列。embedded 仅在 pythonPath 给定且文件存在时
 * 参与，并排最前；forceStrategy 非 'auto' 时只保留该策略。
 */
function buildStrategies(
  opts: DetectOptions,
): Array<{ name: PrAgentStrategy; probe: () => Promise<ProbeResult> }> {
  const pyPath = opts.embeddedPythonPath;
  const all: Array<{ name: PrAgentStrategy; probe: () => Promise<ProbeResult> }> = [];
  // 嵌入式解释器跑 `python --version`：快，且文件不存在时直接判不可用（不阻塞）
  if (pyPath && existsSync(pyPath)) {
    all.push({ name: 'embedded', probe: () => exec(pyPath, ['--version']) });
  }
  all.push({ name: 'local-cli', probe: probeLocalCli });
  all.push({ name: 'docker', probe: probeDocker });
  const force = opts.forceStrategy ?? 'auto';
  return force === 'auto' ? all : all.filter((s) => s.name === force);
}

/**
 * 按优先级探测 pr-agent 可用性：embedded（随 app 打包）→ local CLI（pipx）→ Docker。
 * 返回首个成功的策略；全部失败则报告所有尝试结果。
 */
export async function detectPrAgent(opts: DetectOptions = {}): Promise<PrAgentStatus> {
  const strategies = buildStrategies(opts);
  const failed: Array<{ strategy: PrAgentStrategy; error: string; probeMs: number }> = [];
  for (const { name, probe } of strategies) {
    const r = await probe();
    if (r.ok) {
      // version 字段语义：用户在 UI 看到的"pr-agent 版本"。
      // - docker：probe 拿到 docker daemon 版本，跟镜像无关 → 改成 pin 的 image tag
      // - embedded：另查 importlib.metadata 拿实际安装的 pr-agent 版本 (`pr-agent 0.36.0`)，
      //   而非解释器的 Python 版本（用户关心的是 pr-agent 版本）
      // - local-cli：`pr-agent --help` 首行，保持原值
      let version: string;
      if (name === 'docker') {
        version = `pragent/pr-agent:${DEFAULT_DOCKER_IMAGE_TAG}`;
      } else if (name === 'embedded') {
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
 * 探测并构造一个可调用的 PrAgentBridge。embedded 优先（需传 embeddedPythonPath）→
 * LocalCli → Docker；都不可用时返回 null + status（UI 走 unavailable 占位）。
 * 可注入 ExecFn 便于单测 / mock。
 */
export async function createPrAgentBridge(
  opts: DetectOptions & { exec?: ExecFn } = {},
): Promise<{ bridge: PrAgentBridge | null; status: PrAgentStatus }> {
  const status = await detectPrAgent(opts);
  if (!status.available) return { bridge: null, status };
  const exec = opts.exec ?? defaultExec;
  let bridge: PrAgentBridge;
  if (status.strategy === 'embedded') {
    // detectPrAgent 选中 embedded 时 embeddedPythonPath 必定存在（buildStrategies 已校验）
    bridge = new EmbeddedRuntimeBridge(status.version, opts.embeddedPythonPath!, exec);
  } else if (status.strategy === 'local-cli') {
    bridge = new LocalCliBridge(status.version, exec);
  } else {
    bridge = new DockerBridge(status.version, exec);
  }
  return { bridge, status };
}
