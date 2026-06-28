import type { CommandContext, RootCommand } from './types';
import { buildSettingsCommands } from './settings';

export * from './types';

/**
 * 命令注册表：聚合各领域命令构建器。**新增领域 = 加一个 `<domain>.ts` 文件 + 在此登记**，
 * 上层（CommandPalette）只认 `buildRootCommands`。命令在面板里按此数组顺序、各自的 category 前缀分组。
 */
const DOMAIN_BUILDERS: ReadonlyArray<(ctx: CommandContext) => RootCommand[]> = [buildSettingsCommands];

export function buildRootCommands(ctx: CommandContext): RootCommand[] {
  return DOMAIN_BUILDERS.flatMap((build) => build(ctx));
}
