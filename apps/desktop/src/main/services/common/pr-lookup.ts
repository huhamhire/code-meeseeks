import type { BootstrapResult } from '@meebox/config';
import { listStoredPullRequests } from '@meebox/poller';
import type { RepoIdentity } from '@meebox/repo-mirror';
import type { PlatformAdapter, StoredPullRequest } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../../adapters.js';

export interface PrLookup {
  /** 按 localId 在状态库定位 PR，找不到抛错（统一错误文案）。 */
  findPrOrThrow(localId: string): Promise<StoredPullRequest>;
  /** PR → RepoIdentity（host/projectKey/repoSlug），connection 缺失抛错。 */
  repoIdentityFor(pr: StoredPullRequest): RepoIdentity;
  /** PR 对应连接的 adapter；连接无 adapter 时返回 undefined。 */
  adapterFor(pr: StoredPullRequest): PlatformAdapter | undefined;
  /** 同 adapterFor，但无 adapter 时抛错（绝大多数 handler 走它）。 */
  adapterForOrThrow(pr: StoredPullRequest): PlatformAdapter;
}

export function createPrLookup(deps: {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  connectionRuntime: ConnectionRuntime;
}): PrLookup {
  const { bootstrap, stateStore, connectionRuntime } = deps;

  const findPrOrThrow = async (localId: string): Promise<StoredPullRequest> => {
    const prs = await listStoredPullRequests(stateStore);
    const pr = prs.find((p) => p.localId === localId);
    if (!pr) throw new Error(`PR not found in local state: ${localId}`);
    return pr;
  };

  const repoIdentityFor = (pr: StoredPullRequest): RepoIdentity => {
    const conn = bootstrap.config.connections.find((c) => c.id === pr.connectionId);
    if (!conn) throw new Error(`connection not found: ${pr.connectionId}`);
    return {
      host: new URL(conn.base_url).hostname,
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
    };
  };

  const adapterFor = (pr: StoredPullRequest): PlatformAdapter | undefined =>
    connectionRuntime.adapters.find((a) => a.connectionId === pr.connectionId)?.adapter;

  const adapterForOrThrow = (pr: StoredPullRequest): PlatformAdapter => {
    const adapter = adapterFor(pr);
    if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
    return adapter;
  };

  return { findPrOrThrow, repoIdentityFor, adapterFor, adapterForOrThrow };
}
