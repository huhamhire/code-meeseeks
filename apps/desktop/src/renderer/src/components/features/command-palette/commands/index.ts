import type { CommandContext, RootCommand } from './types';
import { buildPrCommands } from './pr';
import { buildReviewCommands } from './review';
import { buildSettingsCommands } from './settings';

export * from './types';

/**
 * 命令注册表：聚合各领域命令构建器。**新增领域 = 加一个 `<domain>.ts` 文件 + 在此登记**，
 * 上层（CommandPalette）只认 `buildRootCommands`。命令在面板里按此数组顺序、各自的 category 前缀分组；
 * 领域按**英文名字典序**固定排列（PR < Review < Settings），新增领域按此序插入对应位置。
 */
const DOMAIN_BUILDERS: ReadonlyArray<(ctx: CommandContext) => RootCommand[]> = [
  buildPrCommands,
  buildReviewCommands,
  buildSettingsCommands,
];

export function buildRootCommands(ctx: CommandContext): RootCommand[] {
  return DOMAIN_BUILDERS.flatMap((build) => build(ctx));
}
