import type { BootstrapResult } from '@meebox/config';
import { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from '../services/broadcast.js';
import { showPollNotifications } from '../services/notifications.js';

/**
 * 构造轮询器：tick 广播 poll:tick + 触发顺带副作用（onTickExtras）；PR 变更顺手 syncMirror 跟本地镜像。
 * 启动时不带连接（connections:[]），由 connections-runtime 的 wire/setConnections 注入；run/agent 等
 * 后绑定依赖（ipcControl / repoMirror）经回调与 getter 延迟取用（它们在 poller 之后才建好）。
 */
export function createPoller(deps: {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  /** 归档 PR 冷存储（`archived/` 根，与 state/ 平级）；退场 PR 整树搬入此处。 */
  archiveStore: JsonFileStateStore;
  logger: Logger;
  /** poll tick 顺带的副作用（清理消失 PR 的 agent 操作 / 版本检测 / AutoPilot 准入），由 index 绑定。 */
  onTickExtras: () => void;
  /** 延迟取 repoMirror（它在 poller 之后才建好）。 */
  getRepoMirror: () => RepoMirrorManager;
  /** 延迟取连接运行时（它在 poller 之后才建好）：通知服务据此按 connectionId 取 adapter 拉发起人头像。 */
  getConnectionRuntime: () => ConnectionRuntime;
  /** 评论变更（回复 / 提及）顺手失效该 PR 评论缓存 + 广播 comments:changed（延迟经 ipcControl）。 */
  invalidateCommentsCache: (localId: string) => void;
}): Poller {
  const { bootstrap, stateStore, archiveStore, logger } = deps;
  return new Poller({
    connections: [],
    stateStore,
    archiveStore,
    intervalSeconds: bootstrap.config.poller.interval_seconds,
    logger: logger.child({ scope: 'poller' }),
    onTick: (info) => {
      broadcast('poll:tick', info);
      deps.onTickExtras();
    },
    // 本轮新发生的提醒事件（新 PR / 被 @ / 被回复）→ 按通知配置弹系统通知（现读 bootstrap.config，与设置页热生效）。
    // 头像经连接运行时按 connectionId 取 adapter 拉取并落盘（Windows 富 toast 用）。
    onNotify: (events) => {
      void showPollNotifications(events, bootstrap.config, logger, {
        cacheDir: bootstrap.paths.cacheDir,
        getAdapter: (id) =>
          deps.getConnectionRuntime().adapters.find((a) => a.connectionId === id)?.adapter ?? null,
        logger,
      });
      // 评论类事件（回复 / 提及）= 该 PR 评论已变 → 失效缓存 + 广播 comments:changed，刷新已打开视图。
      // 与系统通知是否真正弹出无关（通知设置可能关）：只要轮询发现评论变更就刷新当前打开的 Diff / 活动时间线。
      const commentPrIds = new Set(
        events.filter((e) => e.kind !== 'new_pr').map((e) => e.localId),
      );
      for (const localId of commentPrIds) deps.invalidateCommentsCache(localId);
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
