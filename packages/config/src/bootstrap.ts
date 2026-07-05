import fs from 'node:fs/promises';
import { getAppDir, buildAppPaths } from './paths.js';
import { readConfig, writeConfig, defaultConfig } from './config-store.js';
import type { AppPaths, Config } from '@meebox/shared';

export interface BootstrapResult {
  paths: AppPaths;
  config: Config;
  /** ~/.code-meeseeks/ created on this launch (first run) */
  firstRun: boolean;
}

/**
 * Called once at application startup:
 * - Ensure `~/.code-meeseeks/` and its subdirectories exist
 * - If config.yaml is absent, write default values
 * - If present, read it and validate against the schema
 * - Resolve reposDir, return AppPaths + Config + firstRun flag
 */
export async function ensureWorkspace(): Promise<BootstrapResult> {
  const appDir = getAppDir();

  let firstRun = false;
  try {
    await fs.access(appDir);
  } catch {
    firstRun = true;
  }

  // Create subdirectories before loading config, so later log/state writes need not re-check
  const stubPaths = buildAppPaths('~/.code-meeseeks/repos');
  for (const dir of [
    stubPaths.appDir,
    stubPaths.stateDir,
    stubPaths.logsDir,
    stubPaths.agentDir,
    stubPaths.cacheDir,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }

  let config = await readConfig(stubPaths.configFile);
  if (!config) {
    config = defaultConfig();
    await writeConfig(stubPaths.configFile, config);
  }

  const paths = buildAppPaths(config.workspace.repos_dir);
  await fs.mkdir(paths.reposDir, { recursive: true });

  return { paths, config, firstRun };
}
