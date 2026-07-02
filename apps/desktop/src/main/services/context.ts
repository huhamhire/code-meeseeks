import type { Logger } from 'pino';
import { scaffoldAgentDir } from '@meebox/agent';
import type { BootstrapResult } from '@meebox/config';
import type { PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PrAgentStatus } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import type { Orchestrator } from './agent/index.js';
import { broadcast } from './broadcast.js';
import { PrService } from './pr-service.js';
import type { RunQueue } from './pr-agent/index.js';

/** registerIpcHandlers 的外部依赖（由 main/index.ts 注入）。 */
export interface RegisterDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
  /** 惰性取 pr-agent 探测状态：探测异步进行（不阻塞建窗），await 拿最终结果 */
  getPrAgentStatus: () => Promise<PrAgentStatus>;
  /** 惰性取 bridge 实例；探测未完成 / 不可用 (embedded / CLI 都没有) 时为 null */
  getPrAgentBridge: () => PrAgentBridge | null;
  /** 嵌入式运行时解释器路径（embedded 策略下执行期补 .secrets.toml 用），非 embedded 可空 */
  embeddedPythonPath?: string;
  stateStore: JsonFileStateStore;
  /** 归档 PR 冷存储（archived/ 根，与 state/ 平级）：「已关闭」视图列表 + 打开已归档 PR 详情时读。 */
  archiveStore: JsonFileStateStore;
  poller: Poller;
  /** 可变连接运行时（全量 adapters + adapterByHost）；设置页改连接后被 reconfigure 原地替换 */
  connectionRuntime: ConnectionRuntime;
  /** 重建 adapters/poller 使连接变更热生效（config:setConnections 写盘后调用） */
  reconfigureConnections: () => Promise<void>;
  repoMirror: RepoMirrorManager;
  /** 重建本地 API 监听器使 service 配置（开关 / host / port）变更热生效（config:setService 写盘后调用）。 */
  reconfigureApiServer: () => Promise<void>;
}

/**
 * 各 service 共享的运行时上下文：外部依赖 + 跨域工具（广播 / Agent 目录）+ PR 领域服务。
 * 跨域服务（run 队列 / Agent 编排）在此之上由 ipc.ts 合成 ControllerContext，避免构造环。
 */
export interface ServiceContext extends RegisterDeps {
  /** 向所有窗口广播 main → renderer 事件（按 IpcEvents 强类型）。 */
  broadcast: typeof broadcast;
  /** 生效的 Agent 目录：用户配置优先，未配置则回落默认位置（~/.code-meeseeks/agent）。 */
  effectiveAgentDir(): string;
  /**
   * 取生效 Agent 目录并**幂等补齐**上下文模版（SOUL/AGENTS/MEMORY/USER + rules/）后返回其路径。
   * 「用时初始化」：与现读现装配同口径——无论目录经启动默认 / 应用内热切换 / 直改配置文件后重启而来，
   * 每次加载前都先确保已初始化，不依赖首启或设置交互这类一次性时机。幂等（已存在不覆盖）；失败仅告警、
   * 不抛（loadAgentContext / loadAgentRules 仍会按缺失文件降级）。
   */
  ensureAgentDir(): Promise<string>;
  /** PR 领域服务：PR 定位 / adapter / 镜像 / diff base / 评论缓存。 */
  pr: PrService;
}

/**
 * controller 层统一上下文：在 ServiceContext 之上再挂两个跨域 service（run 队列 / Agent 编排），
 * 使所有 controller 共享同一 `ctx` 入参即可拿到全部能力，签名统一为 `(ctx, req, evt)`。
 * 两个跨域服务以基础 ServiceContext 构建（见 ipc.ts 装配顺序），构建完成后合成本上下文。
 */
export interface ControllerContext extends ServiceContext {
  runQueue: RunQueue;
  orchestrator: Orchestrator;
}

export function createServiceContext(deps: RegisterDeps): ServiceContext {
  const effectiveAgentDir = (): string =>
    deps.bootstrap.config.agent.dir || deps.bootstrap.paths.agentDir;
  return {
    ...deps,
    broadcast,
    effectiveAgentDir,
    ensureAgentDir: async () => {
      const dir = effectiveAgentDir();
      try {
        const created = await scaffoldAgentDir(dir);
        if (created.length) deps.logger.info({ agentDir: dir, created }, 'agent dir scaffolded');
      } catch (err) {
        deps.logger.warn({ err, agentDir: dir }, 'ensure agent dir scaffold failed');
      }
      return dir;
    },
    pr: new PrService({
      bootstrap: deps.bootstrap,
      stateStore: deps.stateStore,
      archiveStore: deps.archiveStore,
      connectionRuntime: deps.connectionRuntime,
      repoMirror: deps.repoMirror,
    }),
  };
}

// === controller 层进程级单例上下文 ===
// registerIpcHandlers 启动时合成一次 ControllerContext（base + runQueue + orchestrator）并安装；
// controller 经 getContext() 取用，从而 handler 签名回归标准 ipcMain.handle 形态 (req, evt)、不带 ctx。
// 单一真相、随进程生命周期存活；测试可先 setControllerContext(mock) 再调 controller。
let currentContext: ControllerContext | undefined;

/** 由 registerIpcHandlers 在装配完成后调用，安装进程级 controller 上下文单例。 */
export function setControllerContext(ctx: ControllerContext): void {
  currentContext = ctx;
}

/** 取 controller 上下文单例；未初始化（registerIpcHandlers 之前 / 模块加载期）即抛错兜住时序。 */
export function getContext(): ControllerContext {
  if (!currentContext) {
    throw new Error('ControllerContext 尚未初始化（registerIpcHandlers 未调用）');
  }
  return currentContext;
}
