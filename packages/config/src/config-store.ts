import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigSchema, type Config } from '@meebox/shared';

/**
 * 读取 config.yaml 并校验。文件不存在时返回 null（由 bootstrap 决定是否创建）。
 */
export async function readConfig(configFile: string): Promise<Config | null> {
  let text: string;
  try {
    text = await fs.readFile(configFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const raw = parseYaml(text) ?? {};
  return ConfigSchema.parse(raw);
}

/**
 * 原子写入 config.yaml：先写 tmp，fsync，再 rename。
 */
export async function writeConfig(configFile: string, config: Config): Promise<void> {
  const yaml = stringifyYaml(config);
  const dir = path.dirname(configFile);
  const tmp = path.join(dir, `.${path.basename(configFile)}.${process.pid}.tmp`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(yaml, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, configFile);
}

/** 默认配置：所有字段走 zod schema 的 default 值。 */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
