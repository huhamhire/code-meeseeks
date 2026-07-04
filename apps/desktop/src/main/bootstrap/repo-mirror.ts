import type { BootstrapResult } from '@meebox/config';
import { RepoMirrorManager } from '@meebox/repo-mirror';
import type { Logger } from 'pino';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from '../services/broadcast.js';
import { buildProxyEnv } from '../utils/proxy.js';

/**
 * Constructs the local repo mirror manager: the clone url is resolved via the connection runtime by
 * looking up the adapter by host (connection changes in settings take effect live, by reading the
 * runtime reference); progress is broadcast on sync:progress; the outbound proxy getter is evaluated
 * on every remote clone/fetch (proxy changes take effect immediately).
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
