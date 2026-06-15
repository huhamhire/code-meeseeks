import type { ToolCatalogEntry } from '@meebox/shared';

/**
 * 工具目录与修改红线（见 docs/arch/06-agent.md「工具修改红线」）。
 *
 * 读 / 分析类工具 Agent 始终可自主调用；修改类（对远端有副作用）**默认禁止**，仅在
 * `grants` 显式授权时放行——以**禁用态**注入目录（Agent 知其存在但不可调用），并由
 * `assertToolAllowed` 在分发入口**运行时硬校验**：即便 LLM 越权产出修改类调用也被拒。
 */

/** 只读 / 分析类工具：始终可用。 */
export const READ_TOOLS = [
  { name: '/describe', summary: 'Generate the PR description.' },
  { name: '/review', summary: 'Generate review findings.' },
  { name: '/ask', summary: 'Ask a free-form question about the PR.' },
] as const;

/** 修改类工具：对远端有副作用，默认禁止；`grant` 是授权它所需的 grants 项。 */
export const MUTATING_TOOLS = [
  { name: '/approve', summary: 'Approve the PR.', grant: 'approve' },
  { name: '/needswork', summary: 'Request changes on the PR.', grant: 'needs_work' },
  { name: '/publish', summary: 'Publish review comments to the remote.', grant: 'publish_comment' },
] as const;

/**
 * 构建工具目录：读类 enabled=true；修改类仅在 grants 含其授权项时 enabled，否则禁用态。
 */
export function buildToolCatalog(grants: ReadonlyArray<string> = []): ToolCatalogEntry[] {
  const granted = new Set(grants);
  return [
    ...READ_TOOLS.map(
      (t): ToolCatalogEntry => ({ name: t.name, summary: t.summary, mutating: false, enabled: true }),
    ),
    ...MUTATING_TOOLS.map(
      (t): ToolCatalogEntry => ({
        name: t.name,
        summary: t.summary,
        mutating: true,
        enabled: granted.has(t.grant),
      }),
    ),
  ];
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
  if (!entry) throw new Error(`未知工具：${toolName}`);
  if (entry.mutating && !entry.enabled) {
    throw new Error(
      `工具 ${toolName} 为修改类且未授权，红线拒绝（需 grants 显式授权或用户直接指令）`,
    );
  }
}
