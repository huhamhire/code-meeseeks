import os from 'node:os';
import path from 'node:path';
import type { AppPaths } from '@meebox/shared';

/**
 * Expand a leading `~` in a path to the user's home directory. Only supports a leading `~/...` or `~`, not `~user/...`.
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Application data root directory (fixed): `~/.code-meeseeks/`. */
export function getAppDir(): string {
  return path.join(os.homedir(), '.code-meeseeks');
}

/**
 * Assemble AppPaths from the loaded reposDir config value.
 * `reposDirRaw` comes from config.yaml, may contain `~`, and is expanded to an absolute path here.
 */
export function buildAppPaths(reposDirRaw: string): AppPaths {
  const appDir = getAppDir();
  return {
    appDir,
    configFile: path.join(appDir, 'config.yaml'),
    stateDir: path.join(appDir, 'state'),
    archivedDir: path.join(appDir, 'archived'),
    logsDir: path.join(appDir, 'logs'),
    agentDir: path.join(appDir, 'agent'),
    cacheDir: path.join(appDir, 'cache'),
    reposDir: path.resolve(expandHome(reposDirRaw)),
  };
}
