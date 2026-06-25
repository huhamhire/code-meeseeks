# 编辑器主题（vendored）

本目录的 `*.json` 为代码编辑器（Monaco）可选配色主题，取自
[brijeshb42/monaco-themes](https://github.com/brijeshb42/monaco-themes)（MIT License），
按 `EDITOR_THEME_OPTIONS`（`@meebox/shared`）的 id 重命名为 kebab-case。

就地内置（vendored）而非作为 npm 依赖引入，因 monaco-themes 的 `exports` 未暴露 `./themes/*` 子路径，
打包器无法解析其内部 JSON。各文件为 `monaco.editor.IStandaloneThemeData` 形状，经 monaco-setup 的
`defineTheme` 注册。

原始主题多源自社区 TextMate 主题，版权归各自作者；此处仅作再分发，保留上述出处与许可声明。
