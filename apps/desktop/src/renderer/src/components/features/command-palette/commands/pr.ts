import type { PrDiscoveryFilter } from '@meebox/shared';
import type { CommandContext, RootCommand } from './types';
import { formatChord } from './shortcuts';

/** 发现分类标签 i18n key（与 Sidebar 发现 tabs 同源；具体可用哪几类由 platform 能力决定）。 */
const DISCOVERY_LABEL_KEYS: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'sidebar.discoveryReviewRequested',
  created: 'sidebar.discoveryCreated',
  assigned: 'sidebar.discoveryAssigned',
  mentioned: 'sidebar.discoveryMentioned',
};

/**
 * 「PR」领域命令：
 * - **一级分类**：每个发现分类（待我评审 / 我创建 / 指派我 / 提及我）各成一条一级命令，直接跳转；选项随
 *   当前 platform 能力门控，无分类的平台不提供。不显示当前选中态。
 * - **分类筛选（二级）**：筛选 PR 状态（待处理 / 全部 / 冲突 / 可合并等，与侧栏一致、随平台门控）。
 * - **切换 PR 列表**：折叠 / 展开侧栏。
 */
export function buildPrCommands(ctx: CommandContext): RootCommand[] {
  const { t, tEn, discoveryFilters, setDiscoveryFilter, prStatusFilters, setPrStatusFilter } = ctx;
  const category = t('commandPalette.categoryPr');
  const categoryEn = tEn('commandPalette.categoryPr');
  const out: RootCommand[] = [];

  // 一级分类：按平台能力提供的顺序各成一条「查看「XXX」」命令（与 Sidebar 发现 tabs 同序），不显示选中态
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

  // 查看已关闭：切到归档（已关闭）范围浏览
  out.push({
    id: 'view-archived',
    category,
    categoryEn,
    title: t('commandPalette.cmdViewArchived'),
    titleEn: tEn('commandPalette.cmdViewArchived'),
    run: () => ctx.viewArchived(),
  });

  // 分类筛选：二级选择 PR 状态
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
