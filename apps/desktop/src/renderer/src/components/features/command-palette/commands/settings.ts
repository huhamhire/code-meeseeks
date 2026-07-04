import type { EditorTheme, SupportedLanguage } from '@meebox/shared';
import { EDITOR_THEME_OPTIONS, LANGUAGE_OPTIONS } from '@meebox/shared';
import { invoke } from '../../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../../i18n';
import { setEditorAppearance } from '../../../../stores/editor-appearance-store';
import type { CommandContext, CommandOption, RootCommand } from './types';
import { formatChord } from './shortcuts';

function switchLanguage(ctx: CommandContext, next: SupportedLanguage): void {
  void i18n.changeLanguage(next); // live switch in the render layer
  persistLanguage(next); // localStorage cache, hit on next launch
  ctx.patchConfig((c) => ({ ...c, language: next })); // sync boot.config
  void invoke('config:setLanguage', { language: next }); // write to disk + main-process i18n
}

function switchTheme(ctx: CommandContext, next: EditorTheme): void {
  const ap = ctx.config.appearance;
  // Apply live: write the shared store → App's useGlobalTheme derives data-theme / chrome / persistence; font unchanged, keeps current value.
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
 * "Settings" domain commands (P1): switch language / theme / model, toggle proxy, open settings / about / DevTools.
 * title is localized in the current language (search matches the current language); second-level options are lazily evaluated, reading the current config to mark the active item.
 */
export function buildSettingsCommands(ctx: CommandContext): RootCommand[] {
  const { t, tEn, config } = ctx;
  const category = t('commandPalette.categorySettings');
  const categoryEn = tEn('commandPalette.categorySettings');
  const currentLang = resolveUiLanguage(config.language);
  // Dual title, localized + English (including domain prefix), for two-line display + always searchable in English
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
      // Languages display by endonym (consistent across all UI languages, not translated) → no titleEn needed
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
      // Themes use proper names (GitHub Dark / Monokai…, not translated); only 'auto' goes through i18n (consistent with the settings page)
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
        // Fixed "add model…" entry at the end: opens the settings "model" section to create a new profile (the only item when there are no profiles)
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
      // Toggle commands use a single label (not flipped by state); check the current toggle state on the settings page
      ...cmd('commandPalette.cmdToggleProxy'),
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
      // DevTools convention: mac ⌥⌘I / others Ctrl+Shift+I (see App window-level shortcuts)
      shortcut: formatChord(ctx.platform, 'I', ctx.platform === 'darwin' ? { alt: true } : { shift: true }),
      run: () => {
        void invoke('app:openDevTools', undefined);
      },
    },
  ];
}
