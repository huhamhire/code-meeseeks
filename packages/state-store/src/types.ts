/**
 * Persistent KV abstraction. Phase-one JSON file implementation; can switch to SQLite once trigger conditions are met.
 *
 * Keys look like `connections` / `runs/pr-42/run-xyz`, with structure guaranteed by the caller.
 * The implementation is responsible for mapping keys to concrete storage locations and guaranteeing write atomicity.
 */
export interface StateStore {
  /** Reads a key; returns null if it does not exist. */
  read<T>(key: string): Promise<T | null>;
  /** Atomically writes a key; creates parent directories automatically. */
  write<T>(key: string, data: T): Promise<void>;
  /** Deletes a key; nop if it does not exist. */
  delete(key: string): Promise<void>;
  /** Lists all keys under the given prefix (without values). */
  list(prefix: string): AsyncIterable<string>;
  /**
   * Recursively deletes the entire directory tree under a prefix (including subdirectories / non-.json files / the whole prefix dir itself).
   * Used to clear all sub-files under `prs/<hash>/` — meta / comments / runs etc. — in one shot when a PR exits.
   * no-op if it does not exist / is not a directory.
   */
  deleteDir(prefix: string): Promise<void>;
}
