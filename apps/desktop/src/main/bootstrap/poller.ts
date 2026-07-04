import type { BootstrapResult } from '@meebox/config';
import { Poller } from '@meebox/poller';
import type { RepoMirrorManager } from '@meebox/repo-mirror';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from '../services/broadcast.js';
import { showPollNotifications } from '../services/notifications.js';

/**
 * Construct the poller: each tick broadcasts poll:tick + triggers incidental side effects (onTickExtras);
 * on PR changes it also syncMirror to keep the local mirror up to date. It starts with no connections
 * (connections:[]), injected by connections-runtime's wire/setConnections; later-bound dependencies like
 * run/agent (ipcControl / repoMirror) are taken lazily via callbacks and getters (they're built after
 * the poller).
 */
export function createPoller(deps: {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  /** Archive PR cold storage (`archived/` root, sibling of state/); departed PRs are moved here as a whole tree. */
  archiveStore: JsonFileStateStore;
  logger: Logger;
  /** Incidental side effects of the poll tick (cleaning up agent operations for disappeared PRs / version detection / AutoPilot admission), bound by index. */
  onTickExtras: () => void;
  /** Lazily get repoMirror (it's built after the poller). */
  getRepoMirror: () => RepoMirrorManager;
  /** Lazily get the connections runtime (it's built after the poller): the notification service uses it to get an adapter by connectionId to fetch the author's avatar. */
  getConnectionRuntime: () => ConnectionRuntime;
  /** On comment changes (reply / mention), also invalidate that PR's comment cache + broadcast comments:changed (lazily via ipcControl). */
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
    // Newly occurring alert events this round (new PR / @-mentioned / replied) → pop system notifications per the notification config (now reads bootstrap.config, hot-applies with the settings page).
    // Avatars are fetched via the connections runtime by getting an adapter by connectionId and written to disk (for Windows rich toasts).
    onNotify: (events) => {
      void showPollNotifications(events, bootstrap.config, logger, {
        cacheDir: bootstrap.paths.cacheDir,
        getAdapter: (id) =>
          deps.getConnectionRuntime().adapters.find((a) => a.connectionId === id)?.adapter ?? null,
        logger,
      });
      // Comment-type events (reply / mention) = that PR's comments changed → invalidate cache + broadcast comments:changed, refreshing the already-open view.
      // Independent of whether the system notification actually pops (notification setting may be off): as long as polling finds a comment change, refresh the currently open Diff / activity timeline.
      const commentPrIds = new Set(
        events.filter((e) => e.kind !== 'new_pr').map((e) => e.localId),
      );
      for (const localId of commentPrIds) deps.invalidateCommentsCache(localId);
    },
    // When a PR is added / its content changes, also syncMirror to keep the local mirror up to date, saving the user a fetch when they later open the PR. Failure doesn't block poll
    // (the mirror has its own global queue + error isolation). identity field mapping: poller uses group/repo, repo-mirror still keeps
    // Bitbucket-shaped projectKey/repoSlug (matches the git path layout, kept for easier troubleshooting).
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
