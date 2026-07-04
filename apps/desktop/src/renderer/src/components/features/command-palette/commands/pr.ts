import type { PrDiscoveryFilter } from '@meebox/shared';
import type { CommandContext, RootCommand } from './types';
import { formatChord } from './shortcuts';

/** i18n keys for discovery filter labels (same source as the Sidebar discovery tabs; which ones are available is decided by platform capability). */
const DISCOVERY_LABEL_KEYS: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'sidebar.discoveryReviewRequested',
  created: 'sidebar.discoveryCreated',
  assigned: 'sidebar.discoveryAssigned',
  mentioned: 'sidebar.discoveryMentioned',
};

/**
 * "PR" domain commands:
 * - **Top-level filters**: each discovery filter (review requested / created / assigned / mentioned) becomes one top-level command that jumps directly; options are
 *   gated by the current platform's capability, and platforms without a filter don't offer it. No current-selection state shown.
 * - **Filter by category (second level)**: filter PR status (pending / all / conflict / mergeable etc., consistent with the sidebar, gated by platform).
 * - **Toggle PR list**: collapse / expand the sidebar.
 */
export function buildPrCommands(ctx: CommandContext): RootCommand[] {
  const { t, tEn, discoveryFilters, setDiscoveryFilter, prStatusFilters, setPrStatusFilter } = ctx;
  const category = t('commandPalette.categoryPr');
  const categoryEn = tEn('commandPalette.categoryPr');
  const out: RootCommand[] = [];

  // Top-level filters: in the order the platform capability provides, each becomes a "view «XXX»" command (same order as the Sidebar discovery tabs), no selection state shown
  for (const f of discoveryFilters) {
    const label = t(DISCOVERY_LABEL_KEYS[f]);
    const labelEn = tEn(DISCOVERY_LABEL_KEYS[f]);
    out.push({
      id: `pr-discovery-${f}`,
      category,
      categoryEn,
      title: t('commandPalette.cmdViewDiscovery', { label }),
      titleEn: tEn('commandPalette.cmdViewDiscovery', { label: labelEn }),
      run: () => setDiscoveryFilter(f),
    });
  }

  // View closed: switch to the archived (closed) scope to browse. Shortcut uses H (history); mac uses ⌘⇧H to avoid the system "Hide App" (⌘H),
  // other platforms Ctrl+H (browser history convention). See App window-level shortcuts.
  out.push({
    id: 'view-archived',
    category,
    categoryEn,
    title: t('commandPalette.cmdViewArchived'),
    titleEn: tEn('commandPalette.cmdViewArchived'),
    shortcut: formatChord(ctx.platform, 'H', ctx.platform === 'darwin' ? { shift: true } : undefined),
    run: () => ctx.viewArchived(),
  });

  // Filter by category: second level selects PR status
  out.push({
    id: 'filter-pr',
    category,
    categoryEn,
    title: t('commandPalette.cmdFilterPrCategory'),
    titleEn: tEn('commandPalette.cmdFilterPrCategory'),
    optionsPlaceholder: t('commandPalette.pickPrCategory'),
    options: () =>
      prStatusFilters.map((f) => ({
        id: f.value,
        title: t(f.labelKey),
        titleEn: tEn(f.labelKey),
        run: () => setPrStatusFilter(f.value),
      })),
  });

  // Open URL (current platform): free-text second level, paste / type a PR link and Enter to open (review others' PRs you weren't formally requested on)
  out.push({
    id: 'open-pr-url',
    category,
    categoryEn,
    title: t('commandPalette.cmdOpenPrUrl'),
    titleEn: tEn('commandPalette.cmdOpenPrUrl'),
    // Shortcut jumps straight to the input level (U = URL); mac ⌘⇧U / others Ctrl+Shift+U, see CommandPalette window-level listener
    shortcut: formatChord(ctx.platform, 'U', { shift: true }),
    // The input-level prefix uses just a short "URL" (generic, no i18n), not the full command title
    prefixLabel: 'URL',
    input: {
      placeholder: t('commandPalette.openPrUrlPlaceholder'),
      run: (text) => ctx.openPrByUrl(text),
    },
  });

  out.push({
    id: 'toggle-pr-list',
    category,
    categoryEn,
    title: t('commandPalette.cmdTogglePrList'),
    titleEn: tEn('commandPalette.cmdTogglePrList'),
    shortcut: formatChord(ctx.platform, 'B'),
    run: () => ctx.togglePrList(),
  });

  return out;
}
