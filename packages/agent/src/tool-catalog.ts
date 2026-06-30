import { TOOLS, type ToolCatalogEntry } from '@meebox/shared';

/**
 * 工具目录与修改红线（见 docs/arch/02-agent/01-agent.md「工具修改红线」）。读 / 分析类工具 Agent 始终可自主调用；
 * 修改类（对远端有副作用）**默认禁止**，仅在 `grants` 显式授权时放行——以**禁用态**注入目录（Agent 知其
 * 存在但不可调用），并由 `assertToolAllowed` 在分发入口**运行时硬校验**：即便 LLM 越权产出修改类调用也被拒。
 * 工具清单（读 / 改 / grant）来自 @meebox/shared 的统一注册表 `TOOLS`（tool-registry）。
 */

/**
 * 构建工具目录：读类 enabled=true；修改类仅在 grants 含其授权项时 enabled，否则禁用态。从注册表派生。
 */
export function buildToolCatalog(grants: ReadonlyArray<string> = []): ToolCatalogEntry[] {
  const granted = new Set(grants);
  return TOOLS.map(
    (t): ToolCatalogEntry => ({
      name: t.command,
      summary: t.summary,
      mutating: t.kind === 'mutating',
      enabled: t.kind === 'mutating' ? granted.has(t.grant) : true,
    }),
  );
}

/**
 * 运行时硬校验（红线落地）：分发某工具前调用。未知工具 / 修改类且未授权 → 抛错；
 * 读类 / 已授权 → 放行。这是「提示词被绕过 ≠ 操作被执行」的最后一道闸。
 */
export function assertToolAllowed(
  toolName: string,
  catalog: ReadonlyArray<ToolCatalogEntry>,
): void {
  const entry = catalog.find((e) => e.name === toolName);
  if (!entry) throw new Error(`Unknown tool: ${toolName}`);
  if (entry.mutating && !entry.enabled) {
    throw new Error(
      `Tool ${toolName} performs a write action and is not authorized; rejected by guardrail (requires explicit grants or a direct user instruction)`,
    );
  }
}
