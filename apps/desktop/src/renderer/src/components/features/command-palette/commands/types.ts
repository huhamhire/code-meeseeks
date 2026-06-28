import type { TFunction } from 'i18next';
import type { Config } from '@meebox/shared';
import type { SettingsCategory } from '../../settings';

/**
 * 命令面板的执行上下文：当前配置 + 同步父级状态的钩子 + 打开设置面板 + 当前语言的 t。
 * 命令的「即时生效」复用设置页同一套原语（i18n.changeLanguage / editor-appearance store / config:* IPC），
 * 不另起一套，保证与设置页行为一致。各领域命令构建器都接收它。
 */
export interface CommandContext {
  config: Config;
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
  title: string;
  /** 英文标题：非英语界面作次行展示，并恒参与检索（对齐 VS Code 显示语言 + 英文检索） */
  titleEn: string;
  category: string;
  /** 英文领域前缀：同 titleEn，用于次行展示与英文检索 */
  categoryEn: string;
  /** 进入二级后的输入框占位提示 */
  optionsPlaceholder?: string;
  /** 二级选项（惰性求值，读当前 config 标注 active）；与 run 二选一 */
  options?: () => CommandOption[];
  /** 叶子命令的执行；与 options 二选一 */
  run?: () => void;
}
