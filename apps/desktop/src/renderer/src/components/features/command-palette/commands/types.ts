import type { TFunction } from 'i18next';
import type { Config, Platform, PrDiscoveryFilter } from '@meebox/shared';
import type { SettingsCategory } from '../../settings';
import type { FilterKey } from '../../../layout/Sidebar';

/**
 * 命令面板的执行上下文：当前配置 + 同步父级状态的钩子 + 打开设置面板 + 当前语言的 t。
 * 命令的「即时生效」复用设置页同一套原语（i18n.changeLanguage / editor-appearance store / config:* IPC），
 * 不另起一套，保证与设置页行为一致。各领域命令构建器都接收它。
 */
export interface CommandContext {
  /** 运行平台：命令格式化快捷键提示（mac ⌘ / 其余 Ctrl）等用。 */
  platform: Platform;
  config: Config;
  /** 当前选中 PR 的 localId（无选中为 null）；上下文相关命令（如运行自动评审）据此裁剪 / 取目标。 */
  selectedPrId: string | null;
  /** 某 PR 是否有编排 Agent 运行中（重入保护用，调用时取实时态）。 */
  isPrRunning: (localId: string) => boolean;
  /** 切换对话面板折叠（命令面板的「切换对话面板」用）。 */
  toggleChatPanel: () => void;
  /** 切换 PR 列表（侧栏）折叠（命令面板的「切换 PR 列表」用）。 */
  togglePrList: () => void;
  /** 当前 platform 能力支持的 PR 发现分类（空=该平台无分类，对应一级命令不提供）。 */
  discoveryFilters: readonly PrDiscoveryFilter[];
  /** 跳到某发现分类（PR 域「查看 X」命令用，如「待我评审」）；隐含切回「进行中」范围。 */
  setDiscoveryFilter: (filter: PrDiscoveryFilter) => void;
  /** 切到「已关闭」（归档）范围（PR 域「查看已关闭」命令用）。 */
  viewArchived: () => void;
  /** 可选的 PR 状态筛选项（待处理 / 全部 / 冲突 / 可合并等，已按平台门控）。 */
  prStatusFilters: ReadonlyArray<{ value: FilterKey; labelKey: string }>;
  /** 设置 PR 状态筛选（PR 域「分类筛选」二级选项用）。 */
  setPrStatusFilter: (filter: FilterKey) => void;
  patchConfig: (updater: (c: Config) => Config) => void;
  openSettings: (category?: SettingsCategory) => void;
  /** 当前界面语言的翻译函数 */
  t: TFunction;
  /** 固定英文（en-US）翻译函数：非英语界面下作次行展示，并恒参与检索（对齐 VS Code） */
  tEn: TFunction;
}

/** 二级选项（叶子，直接执行）。`active` 标注当前生效项（打勾）。 */
export interface CommandOption {
  id: string;
  title: string;
  /** 英文名（缺省=title，即各语言一致的专名/数据项）；非英语界面作次行 + 恒参与检索 */
  titleEn?: string;
  active?: boolean;
  run: () => void;
}

/**
 * 顶层命令：要么直接执行（`run`），要么进入二级选项（`options`）。**最多两级**、不支持返回上级
 * （Esc 退出后重进，见 docs/arch/13）。`title` / `category` 已按当前界面语言本地化，供按当前语言搜索。
 */
export interface RootCommand {
  id: string;
  /** 上下文门控（可选）：返回 false 则该命令不出现在列表。缺省=恒可见。由注册表统一过滤，各领域只需声明。 */
  when?: () => boolean;
  title: string;
  /** 英文标题：非英语界面作次行展示，并恒参与检索（对齐 VS Code 显示语言 + 英文检索） */
  titleEn: string;
  category: string;
  /** 英文领域前缀：同 titleEn，用于次行展示与英文检索 */
  categoryEn: string;
  /** 快捷键按键 token 列表（一键一框，如 `['⌘','B']` / `['Ctrl','B']`），在命令项右侧展示；缺省=无 */
  shortcut?: string[];
  /** 进入二级后的输入框占位提示 */
  optionsPlaceholder?: string;
  /** 二级选项（惰性求值，读当前 config 标注 active）；与 run 二选一 */
  options?: () => CommandOption[];
  /** 叶子命令的执行；与 options 二选一 */
  run?: () => void;
}
