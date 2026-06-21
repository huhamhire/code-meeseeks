import type { BootstrapResult } from '@meebox/config';
import { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import { broadcast } from '../services/broadcast.js';

/**
 * 构造轮询器：tick 广播 poll:tick + 触发顺带副作用（onTickExtras）；PR 变更顺手 syncMirror 跟本地镜像。
 * 启动时不带连接（connections:[]），由 connections-runtime 的 wire/setConnections 注入；run/agent 等
 * 后绑定依赖（ipcControl / repoMirror）经回调与 getter 延迟取用（它们在 poller 之后才建好）。
 */
export function createPoller(deps: {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  logger: Logger;
  /** poll tick 顺带的副作用（清理消失 PR 的 agent 操作 / 版本检测 / AutoPilot 准入），由 index 绑定。 */
  onTickExtras: () => void;
  /** 延迟取 repoMirror（它在 poller 之后才建好）。 */
  getRepoMirror: () => RepoMirrorManager;
}): Poller {
  const { bootstrap, stateStore, logger } = deps;
  return new Poller({
    connections: [],
    stateStore,
    intervalSeconds: bootstrap.config.poller.interval_seconds,
    logger: logger.child({ scope: 'poller' }),
    onTick: (info) => {
      broadcast('poll:tick', info);
      deps.onTickExtras();
    },
    // PR 新增 / 内容变更时顺手 syncMirror 跟上本地镜像，让用户随后点开 PR 省一趟 fetch。失败不阻断 poll
    //（mirror 有自己的全局队列 + 错误隔离）。identity 字段映射：poller 用 group/repo，repo-mirror 仍保留
    // Bitbucket-shaped projectKey/repoSlug（跟 git 路径布局一致，沿用便于排障）。
    onPrsChanged: (repos) => {
      for (const r of repos) {
        const conn = bootstrap.config.connections.find((c) => c.id === r.connectionId);
        if (!conn) continue;
        let host: string;
        try {
          host = new URL(conn.base_url).hostname;
        } catch {
          continue;
        }
        void deps
          .getRepoMirror()
          .syncMirror({ host, projectKey: r.group, repoSlug: r.repo })
          .catch((err) => {
            logger.warn({ err, repo: r }, 'auto syncMirror after poll failed');
          });
      }
    },
  });
}
