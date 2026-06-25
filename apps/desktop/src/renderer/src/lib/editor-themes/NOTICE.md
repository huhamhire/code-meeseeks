# 编辑器主题（vendored）

本目录的 `*.json` 为代码编辑器（Monaco）可选配色主题，均为 `monaco.editor.IStandaloneThemeData`
形状，经 monaco-setup 的 `defineTheme` 注册；按 `EDITOR_THEME_OPTIONS`（`@meebox/shared`）的 id
命名（kebab-case）。来源两类，均为 MIT License：

- 社区主题（GitHub / Monokai / Dracula / Nord / Solarized 等）取自
  [brijeshb42/monaco-themes](https://github.com/brijeshb42/monaco-themes)。
- `dark-2026.json` / `light-2026.json` 由 VS Code 内置默认主题
  [microsoft/vscode](https://github.com/microsoft/vscode)（`extensions/theme-defaults/themes/2026-*.json`）
  转换而来：已解析其 `include` 链（→ dark_modern → …）合并，并把 `tokenColors` / `colors` 转为 Monaco 形状。

就地内置（vendored）而非作为 npm 依赖引入：monaco-themes 的 `exports` 未暴露 `./themes/*` 子路径，
打包器无法解析其内部 JSON；VS Code 主题同理无独立分发包。原始主题部分源自社区 TextMate 主题，版权归
各自作者；此处仅作再分发，保留上述出处与许可声明。

注：Monaco 用 Monarch 着色（非 TextMate 语法），故主题对细粒度 scope 的着色保真度低于 VS Code；
编辑器底色 / 前景 / 常见 token（注释 / 字符串 / 关键字 / 数字等）一致。
