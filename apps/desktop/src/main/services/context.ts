import type { Logger } from 'pino';
import type { BootstrapResult } from '@meebox/config';
import type { PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PrAgentStatus } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import type { AgentOrchestratorService } from './agent-orchestrator.js';
import { broadcast } from './broadcast.js';
import { PrService } from './pr-service.js';
import type { RunQueueService } from './run-queue.js';

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
  poller: Poller;
  /** 可变连接运行时（全量 adapters + adapterByHost）；设置页改连接后被 reconfigure 原地替换 */
  connectionRuntime: ConnectionRuntime;
  /** 重建 adapters/poller 使连接变更热生效（config:setConnections 写盘后调用） */
  reconfigureConnections: () => Promise<void>;
  repoMirror: RepoMirrorManager;
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
  /** PR 领域服务：PR 定位 / adapter / 镜像 / diff base / 评论缓存。 */
  pr: PrService;
}

/**
 * controller 层统一上下文：在 ServiceContext 之上再挂两个跨域 service（run 队列 / Agent 编排），
 * 使所有 controller 共享同一 `ctx` 入参即可拿到全部能力，签名统一为 `(ctx, req, evt)`。
 * 两个跨域服务以基础 ServiceContext 构建（见 ipc.ts 装配顺序），构建完成后合成本上下文。
 */
export interface ControllerContext extends ServiceContext {
  runQueue: RunQueueService;
  orchestrator: AgentOrchestratorService;
}

export function createServiceContext(deps: RegisterDeps): ServiceContext {
  return {
    ...deps,
    broadcast,
    effectiveAgentDir: () => deps.bootstrap.config.agent.dir || deps.bootstrap.paths.agentDir,
    pr: new PrService({
      bootstrap: deps.bootstrap,
      stateStore: deps.stateStore,
      connectionRuntime: deps.connectionRuntime,
      repoMirror: deps.repoMirror,
    }),
  };
}
