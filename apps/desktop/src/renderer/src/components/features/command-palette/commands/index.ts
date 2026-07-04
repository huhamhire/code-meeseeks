import type { CommandContext, RootCommand } from './types';
import { buildPrCommands } from './pr';
import { buildReviewCommands } from './review';
import { buildSettingsCommands } from './settings';

export * from './types';

/**
 * Command registry: aggregates each domain's command builder. **Adding a domain = add one `<domain>.ts` file + register it here**;
 * the upper layer (CommandPalette) only knows `buildRootCommands`. Commands are grouped in the palette by this array's order, each under its own category prefix;
 * domains are fixed in **English-name lexicographic order** (PR < Review < Settings), and new domains are inserted at the corresponding position by this order.
 */
const DOMAIN_BUILDERS: ReadonlyArray<(ctx: CommandContext) => RootCommand[]> = [
  buildPrCommands,
  buildReviewCommands,
  buildSettingsCommands,
];

export function buildRootCommands(ctx: CommandContext): RootCommand[] {
  // Domains follow DOMAIN_BUILDERS' fixed order (PR < Review < Settings); **within a domain, sort uniformly by English-title lexicographic order**,
  // so dynamically generated commands (like discovery filters that vary by platform capability) such as "view X / filter by category / toggle…" also fall into place without per-domain manual ordering.
  // Unified gating: commands declare a when predicate, and the registry filters here uniformly (domains no longer each write their own if).
  return DOMAIN_BUILDERS.flatMap((build) =>
    build(ctx)
      .filter((c) => !c.when || c.when())
      .sort((a, b) => a.titleEn.localeCompare(b.titleEn, 'en')),
  );
}
