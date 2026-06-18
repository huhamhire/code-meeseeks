import type { Logger } from 'pino';
import type { BootstrapResult } from '@meebox/config';
import type { PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { PrAgentStatus } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from './common/broadcast.js';
import { invalidateCommentsCache } from './common/comments-cache.js';
import { createMirrorHelpers, type MirrorHelpers } from './common/mirror.js';
import { createPrLookup, type PrLookup } from './common/pr-lookup.js';

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
 * 各 service 共享的运行时上下文：外部依赖 + 收口好的公共工具（广播 / PR 定位 / 镜像 /
 * 评论缓存 / Agent 目录）。各域 handler 接收 ctx 即可，避免逐个透传裸 deps。
 */
export interface IpcContext extends RegisterDeps, PrLookup, MirrorHelpers {
  /** 向所有窗口广播 main → renderer 事件（按 IpcEvents 强类型）。 */
  broadcast: typeof broadcast;
  /** 清 PR 评论缓存 + 广播 comments:changed。 */
  invalidateCommentsCache(localId: string): Promise<void>;
  /** 生效的 Agent 目录：用户配置优先，未配置则回落默认位置（~/.code-meeseeks/agent）。 */
  effectiveAgentDir(): string;
}

export function createIpcContext(deps: RegisterDeps): IpcContext {
  const prLookup = createPrLookup({
    bootstrap: deps.bootstrap,
    stateStore: deps.stateStore,
    connectionRuntime: deps.connectionRuntime,
  });
  const mirror = createMirrorHelpers({
    repoMirror: deps.repoMirror,
    stateStore: deps.stateStore,
    repoIdentityFor: prLookup.repoIdentityFor,
  });
  return {
    ...deps,
    ...prLookup,
    ...mirror,
    broadcast,
    invalidateCommentsCache: (localId) => invalidateCommentsCache(deps.stateStore, localId),
    effectiveAgentDir: () => deps.bootstrap.config.agent.dir || deps.bootstrap.paths.agentDir,
  };
}
