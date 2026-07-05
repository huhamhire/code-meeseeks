import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigSchema, type Config } from '@meebox/shared';

/**
 * Read config.yaml and validate it. Returns null when the file is absent (bootstrap decides whether to create it).
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
 * Atomic write of config.yaml: write to tmp, fsync, then rename.
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

/** Default config: every field takes the zod schema's default value. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
