import type { EditorTheme, SupportedLanguage } from '@meebox/shared';
import { EDITOR_THEME_OPTIONS, LANGUAGE_OPTIONS } from '@meebox/shared';
import { invoke } from '../../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../../i18n';
import { setEditorAppearance } from '../../../../stores/editor-appearance-store';
import type { CommandContext, CommandOption, RootCommand } from './types';

function switchLanguage(ctx: CommandContext, next: SupportedLanguage): void {
  void i18n.changeLanguage(next); // 渲染层实时切换
  persistLanguage(next); // localStorage 缓存，下次启动命中
  ctx.patchConfig((c) => ({ ...c, language: next })); // 同步 boot.config
  void invoke('config:setLanguage', { language: next }); // 写盘 + 主进程 i18n
}

function switchTheme(ctx: CommandContext, next: EditorTheme): void {
  const ap = ctx.config.appearance;
  // 实时应用：写共享 store → App 的 useGlobalTheme 派生 data-theme / chrome / 持久化；字体不变沿用现值。
  setEditorAppearance({
    editorTheme: next,
    fontFamily: ap.editor_font_family,
    fontSize: ap.editor_font_size,
  });
  ctx.patchConfig((c) => ({ ...c, appearance: { ...c.appearance, editor_theme: next } }));
  void invoke('config:setEditorAppearance', {
    editor_theme: next,
    editor_font_family: ap.editor_font_family,
    editor_font_size: ap.editor_font_size,
  });
}

function switchModel(ctx: CommandContext, id: string): void {
  const next = { ...ctx.config.llm, active_id: id };
  void invoke('config:setLlm', { llm: next });
  ctx.patchConfig((c) => ({ ...c, llm: next }));
}

function toggleProxy(ctx: CommandContext): void {
  const next = { ...ctx.config.proxy, enabled: !ctx.config.proxy.enabled };
  void invoke('config:setProxy', { proxy: next });
  ctx.patchConfig((c) => ({ ...c, proxy: next }));
}

/**
 * 「设置」领域命令（P1）：切换语言 / 主题 / 模型、开关代理、打开设置 / 关于 / DevTools。
 * title 经当前语言本地化（搜索按当前语言匹配）；二级选项惰性求值、读当前 config 标注生效项。
 */
export function buildSettingsCommands(ctx: CommandContext): RootCommand[] {
  const { t, tEn, config } = ctx;
  const category = t('commandPalette.categorySettings');
  const categoryEn = tEn('commandPalette.categorySettings');
  const currentLang = resolveUiLanguage(config.language);
  // 本地化 + 英文双标题（含领域前缀），供两行展示 + 恒按英文检索
  const cmd = (key: string): Pick<RootCommand, 'title' | 'titleEn' | 'category' | 'categoryEn'> => ({
    category,
    categoryEn,
    title: t(key),
    titleEn: tEn(key),
  });
  return [
    {
      id: 'switch-language',
      ...cmd('commandPalette.cmdSwitchLanguage'),
      optionsPlaceholder: t('commandPalette.pickLanguage'),
      // 语言展示用 endonym（各 UI 语言下一致、不翻译）→ 无需 titleEn
      options: () =>
        LANGUAGE_OPTIONS.map((o) => ({
          id: o.code,
          title: o.endonym,
          active: o.code === currentLang,
          run: () => switchLanguage(ctx, o.code),
        })),
    },
    {
      id: 'switch-theme',
      ...cmd('commandPalette.cmdSwitchTheme'),
      optionsPlaceholder: t('commandPalette.pickTheme'),
      // 主题用专名（GitHub Dark / Monokai…，不翻译）；仅 'auto' 走 i18n（与设置页一致）
      options: () =>
        EDITOR_THEME_OPTIONS.map((o) => ({
          id: o.id,
          title: o.id === 'auto' ? t('settings.editorThemeOptionAuto') : o.label,
          titleEn: o.id === 'auto' ? tEn('settings.editorThemeOptionAuto') : o.label,
          active: o.id === config.appearance.editor_theme,
          run: () => switchTheme(ctx, o.id),
        })),
    },
    {
      id: 'switch-model',
      ...cmd('commandPalette.cmdSwitchModel'),
      optionsPlaceholder: t('commandPalette.pickModel'),
      options: () => {
        const items: CommandOption[] = config.llm.profiles.map((p) => ({
          id: p.id,
          title: p.label || p.model || p.provider,
          active: p.id === config.llm.active_id,
          run: () => switchModel(ctx, p.id),
        }));
        // 末尾固定「添加模型…」入口：打开设置的「模型」分区新建预设（无预设时即唯一项）
        items.push({
          id: '__add_model__',
          title: t('commandPalette.addModel'),
          titleEn: tEn('commandPalette.addModel'),
          run: () => ctx.openSettings('model'),
        });
        return items;
      },
    },
    {
      id: 'toggle-proxy',
      // 标题随当前态翻转：已开 → 关闭代理 / 已关 → 开启代理
      ...cmd(config.proxy.enabled ? 'commandPalette.cmdDisableProxy' : 'commandPalette.cmdEnableProxy'),
      run: () => toggleProxy(ctx),
    },
    {
      id: 'open-settings',
      ...cmd('commandPalette.cmdOpenSettings'),
      run: () => ctx.openSettings(),
    },
    {
      id: 'open-about',
      ...cmd('commandPalette.cmdOpenAbout'),
      run: () => ctx.openSettings('about'),
    },
    {
      id: 'open-devtools',
      ...cmd('commandPalette.cmdOpenDevtools'),
      run: () => {
        void invoke('app:openDevTools', undefined);
      },
    },
  ];
}
