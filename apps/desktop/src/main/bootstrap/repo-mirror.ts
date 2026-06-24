import type { BootstrapResult } from '@meebox/config';
import { RepoMirrorManager } from '@meebox/repo-mirror';
import type { Logger } from 'pino';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from '../services/broadcast.js';
import { buildProxyEnv } from '../utils/proxy.js';

/**
 * 构造本地仓库镜像管理器：clone url 经连接运行时按 host 取 adapter 求得（设置页改连接热生效，读 runtime 引用）；
 * 进度广播 sync:progress；出站代理 getter 每次远端 clone/fetch 求值（改代理即生效）。
 */
export function createRepoMirror(deps: {
  bootstrap: BootstrapResult;
  logger: Logger;
  connectionRuntime: ConnectionRuntime;
}): RepoMirrorManager {
  const { bootstrap, logger, connectionRuntime } = deps;
  return new RepoMirrorManager({
    reposDir: bootstrap.paths.reposDir,
    getCloneUrl: async (repo) => {
      const adapter = connectionRuntime.adapterByHost.get(repo.host);
      if (!adapter) throw new Error(`no adapter for host ${repo.host}`);
      return adapter.connection.getCloneUrl({
        projectKey: repo.projectKey,
        repoSlug: repo.repoSlug,
      });
    },
    logger: logger.child({ scope: 'repo-mirror' }),
    onProgress: (event) => broadcast('sync:progress', event),
    proxyEnv: () => buildProxyEnv(bootstrap.config.proxy),
  });
}
