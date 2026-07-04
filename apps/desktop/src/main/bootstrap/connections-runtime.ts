import type { BootstrapResult } from '@meebox/config';
import type { Poller } from '@meebox/poller';
import type { PlatformUser } from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import { buildAdapters, type ConnectionRuntime } from '../adapters.js';
import { writeConnectionStates, type ConnectionState } from '../utils/connection-state.js';

/**
 * Connections runtime controller: consolidates the startup sequence's "connection wiring / ping /
 * hot-reconfigure" out of index.ts. "Wiring" and "ping" are decoupled to achieve "startup does not
 * depend on the network" — see each method's comment. Runtime state (runtime + connection-level local
 * state) is mutable instance state, hence wrapped in a class.
 */
export class ConnectionRuntimeController {
  /** Mutably held connections runtime (full adapters + adapterByHost); IPC / repoMirror read the latest values through the reference. */
  readonly runtime: ConnectionRuntime = { adapters: [], adapterByHost: new Map() };

  constructor(
    private readonly bootstrap: BootstrapResult,
    private readonly stateStore: JsonFileStateStore,
    private readonly poller: Poller,
    private readonly logger: Logger,
    /** Connection-level local state loaded at startup (includes the last ping's currentUser); written back incrementally on each ping. */
    private connectionStates: Record<string, ConnectionState>,
  ) {}

  /** Id list of the currently enabled connections (used by poller.archiveConnectionsExcept). */
  activeConnectionIds(): string[] {
    return this.runtime.adapters
      .filter((a) => a.connectionId === this.bootstrap.config.active_connection_id)
      .map((a) => a.connectionId);
  }

  /** Rebuild adapters/byHost, prewarm currentUser from locally persisted identity, feed the active connection to the poller (synchronous, no network, callable before the window is created). */
  wire(): void {
    const adapters = buildAdapters(this.bootstrap.config.connections, this.bootstrap.config.proxy);
    const byHost = new Map<string, PlatformAdapter>();
    for (const { connectionId, adapter } of adapters) {
      // Prewarm currentUser: if there's a local record, fill it in first (if no record, keep null, ping is the fallback).
      const cachedUser = this.connectionStates[connectionId]?.user;
      if (cachedUser) adapter.connection.setCurrentUser?.(cachedUser);
      const conn = this.bootstrap.config.connections.find((c) => c.id === connectionId);
      if (!conn) continue;
      try {
        byHost.set(new URL(conn.base_url).hostname, adapter);
      } catch (err) {
        this.logger.warn({ err, connectionId, base_url: conn.base_url }, 'invalid base_url');
      }
    }
    this.runtime.adapters = adapters;
    this.runtime.adapterByHost = byHost;
    // Only poll the currently enabled connection (at most one at a time); the rest keep their config but are not polled.
    this.poller.setConnections(
      adapters.filter((a) => a.connectionId === this.bootstrap.config.active_connection_id),
    );
  }

  /** Fully async ping: refresh remote identity and persist incrementally; if the active connection's identity changes (including first acquisition), run one extra poll (has network, not on the startup critical path). */
  ping(): void {
    const activeId = this.bootstrap.config.active_connection_id;
    for (const { connectionId, adapter } of this.runtime.adapters) {
      const isActive = connectionId === activeId;
      const beforeName = adapter.connection.getCurrentUser()?.name ?? null;
      // If the active connection has no cached identity at startup → poller.start(immediate=false) skipped the first round; here, after ping settles, it must trigger
      // the **first sync** (regardless of ping success): "confirm identity first, then sync once immediately".
      const hadIdentity = beforeName !== null;
      void adapter.connection.ping().then(
        async (r) => {
          this.logger.info(
            { connectionId, ok: r.ok, serverVersion: r.serverVersion, user: r.user?.name },
            'adapter ping',
          );
          const user = adapter.connection.getCurrentUser();
          await this.persistConnectionUser(connectionId, user);
          // Trigger reclassification/first sync: active connection and (identity changed, including first acquisition/account switch, or had no identity and needs the first round).
          if (isActive && (!hadIdentity || (user?.name ?? null) !== beforeName)) {
            void this.poller.tick();
          }
        },
        (err: unknown) => {
          this.logger.warn({ err, connectionId }, 'adapter ping failed');
          // ping failed but the active connection had no cached identity (first round skipped) → still sync once with the PAT as fallback, to avoid appearing not synced.
          if (isActive && !hadIdentity) void this.poller.tick();
        },
      );
    }
  }

  /** Hot-apply after the settings page changes connections / proxy: rewire + archive non-active connections (local IO) + async ping. */
  async reconfigure(): Promise<void> {
    this.wire();
    await this.poller.archiveConnectionsExcept(this.activeConnectionIds());
    this.ping();
  }

  /** Persist a connection's currentUser (only writes to disk when identity changes, to avoid pointless IO). A write failure does not affect operation. */
  private async persistConnectionUser(
    connectionId: string,
    user: PlatformUser | null,
  ): Promise<void> {
    const prevName = this.connectionStates[connectionId]?.user?.name ?? null;
    if (prevName === (user?.name ?? null)) return;
    this.connectionStates = {
      ...this.connectionStates,
      [connectionId]: { ...this.connectionStates[connectionId], user },
    };
    try {
      await writeConnectionStates(this.stateStore, this.connectionStates);
    } catch (err) {
      this.logger.warn({ err, connectionId }, 'persist connection user failed');
    }
  }
}
