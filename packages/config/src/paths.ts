import os from 'node:os';
import path from 'node:path';
import type { AppPaths } from '@meebox/shared';

/**
 * 展开路径里的 `~` 为用户 home 目录。仅支持开头 `~/...` 或 `~`，不处理 `~user/...`。
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 应用数据根目录（固定）：`~/.code-meeseeks/`。 */
export function getAppDir(): string {
  return path.join(os.homedir(), '.code-meeseeks');
}

/**
 * 根据已加载的 reposDir 配置值，组装 AppPaths。
 * `reposDirRaw` 来自 config.yaml，可能含 `~`，会在此处展开为绝对路径。
 */
export function buildAppPaths(reposDirRaw: string): AppPaths {
  const appDir = getAppDir();
  return {
    appDir,
    configFile: path.join(appDir, 'config.yaml'),
    stateDir: path.join(appDir, 'state'),
    logsDir: path.join(appDir, 'logs'),
    rulesDir: path.join(appDir, 'rules'),
    cacheDir: path.join(appDir, 'cache'),
    reposDir: path.resolve(expandHome(reposDirRaw)),
  };
}
