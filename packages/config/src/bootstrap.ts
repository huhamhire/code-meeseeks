import fs from 'node:fs/promises';
import { getAppDir, buildAppPaths } from './paths.js';
import { readConfig, writeConfig, defaultConfig } from './config-store.js';
import type { AppPaths, Config } from '@pr-pilot/shared';

export interface BootstrapResult {
  paths: AppPaths;
  config: Config;
  /** ~/.pr-pilot/ 本次启动时新建（首启） */
  firstRun: boolean;
}

/**
 * 应用启动时调用一次：
 * - 确保 `~/.pr-pilot/` 及子目录存在
 * - 若 config.yaml 不存在，写入默认值
 * - 若已存在，读出并 schema 校验
 * - 解析 reposDir，返回 AppPaths + Config + firstRun 标志
 */
export async function ensureWorkspace(): Promise<BootstrapResult> {
  const appDir = getAppDir();

  let firstRun = false;
  try {
    await fs.access(appDir);
  } catch {
    firstRun = true;
  }

  // 子目录创建放在配置加载之前，避免后续日志/state 写入时还需检查
  const stubPaths = buildAppPaths('~/.pr-pilot/repos');
  for (const dir of [
    stubPaths.appDir,
    stubPaths.stateDir,
    stubPaths.logsDir,
    stubPaths.rulesDir,
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
