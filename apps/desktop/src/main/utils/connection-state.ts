import type { PlatformUser } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * Connection-level local state (persisted per connectionId in the state store). Currently only
 * stores the "current user identity from the last ping" to warm up the poller's approved check
 * (correct from the first round, no need to wait for a ping); the structure is intentionally left
 * extensible so other connection-level interaction state (e.g. last-viewed time, list preferences)
 * can be appended here later.
 */
export interface ConnectionState {
  /** The user owning the current PAT from the last ping; used to warm up the adapter's currentUser cache when establishing a connection. */
  user?: PlatformUser | null;
}

interface ConnectionStateFile {
  schema_version: 1;
  /** connectionId → local state of that connection */
  connections: Record<string, ConnectionState>;
}

const KEY = 'connections/state';

/** Read all connection states; returns an empty table when there is no file. */
export async function readConnectionStates(
  store: StateStore,
): Promise<Record<string, ConnectionState>> {
  const file = await store.read<ConnectionStateFile>(KEY);
  return file?.connections ?? {};
}

/** Write the whole table of connection states back. */
export async function writeConnectionStates(
  store: StateStore,
  connections: Record<string, ConnectionState>,
): Promise<void> {
  await store.write<ConnectionStateFile>(KEY, { schema_version: 1, connections });
}
