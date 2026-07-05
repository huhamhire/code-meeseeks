import { TOOLS, type ToolCatalogEntry } from '@meebox/shared';

/**
 * Tool catalog and the mutation red line (see docs/arch/02-agent/01-agent.md "工具修改红线"). Read / analysis tools can always be invoked by the Agent on its own;
 * mutating ones (with side effects on the remote) are **disabled by default** and only allowed when explicitly granted in `grants` — injected into the catalog in a **disabled state** (the Agent knows they
 * exist but cannot call them), and hard-validated at runtime by `assertToolAllowed` at the dispatch entry: even if the LLM produces an out-of-scope mutating call, it is rejected.
 * The tool list (read / mutating / grant) comes from @meebox/shared's unified registry `TOOLS` (tool-registry).
 */

/**
 * Builds the tool catalog: read tools enabled=true; mutating tools enabled only when grants contains their grant item, otherwise disabled. Derived from the registry.
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
 * Runtime hard validation (the red line enforced): called before dispatching a tool. Unknown tool / mutating and unauthorized → throw;
 * read / authorized → allow. This is the last gate that makes "prompt bypassed ≠ action executed".
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
