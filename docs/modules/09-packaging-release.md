# 09 · 打包与发布

## 职责与边界

把应用 + 嵌入式运行时打成各平台安装包并发布。覆盖 electron-builder 配置、嵌入式运行时随包、
代码签名策略、图标、CI 发布流程。

负责：构建/打包/签名/出包/CI。不负责：嵌入式运行时怎么组装（见 [04](04-pragent-runtime.md)）。

## 核心设计

- **构建链**：`prepare:pragent`（组装嵌入式运行时）→ electron-vite `build`（main/preload/renderer）→
  electron-builder 出包。
- **嵌入式运行时随包**：`vendor/pragent`（CPython + pinned pr-agent）经 electron-builder 的 `extraResources`
  落在 **asar 之外**（原生解释器 + `.so/.pyd` 必须是真实文件，不能进 asar）；`__pycache__` 排除瘦身。
  打包平台与目标平台一致（由构建机宿主组装）。
- **目标产物**：Windows → NSIS x64；macOS → dmg arm64。发布只聚焦 **Windows x64 + macOS arm64**；
  **Linux 暂不计划**，Intel / win arm64 视需求后续。（electron-builder 配置里即便保留 linux 段也不在发布范围。）
- **macOS 免费签名路线（ad-hoc）**：不申请 Apple Developer ID（$99/年）。afterPack 钩子对 `.app` 做
  **ad-hoc 递归签名**（`codesign --deep --sign -`）——Apple Silicon 上任何 Mach-O 必须有签名才能运行
  （含嵌入式 python 的上千个 `.so/.dylib`，实测 `--deep` 已完整覆盖，无需逐个补签）。**代价**：不公证，
  用户首次打开需手动「仍要打开」（或走 Homebrew）。**升级公证**：仓库配齐 Apple 签名 secrets 后，afterPack
  检测到凭据会自动让位给 electron-builder 的正式签名 + 公证，workflow 结构不变。
- **图标按平台分**：Windows 用 `.ico`；macOS 用**专用深色圆角图标**——满铺透明 glyph 在 macOS（尤其新系统）
  会被套圆角并垫白底，故单出一张「深色 squircle + 留边 glyph」给 mac；图标源走 Git LFS。
- **CI 发布**：推 `v*` tag 触发，矩阵 `windows-latest` + `macos-14`(arm64) 各自原生出包并挂到该 tag 的 Release；
  checkout 必须 `lfs: true`（否则图标是 LFS 指针 → 转图标崩）。

## 数据 / 接口契约

- **触发**：push tag `v*`（或手动 workflow_dispatch）。
- **产物命名**：`code-meeseeks-<version>-{win-x64.exe | mac-arm64.dmg}`。
- **可选签名凭据**（配齐则自动转正式签名+公证）：证书 .p12（base64）+ 密码、App Store Connect API key 等
  以仓库 secrets 注入；缺失则走 ad-hoc。

## 扩展与注意事项

- **本地复现坑**（CI 不受影响，因为用 `lfs:true` + 干净环境）：本机没装 git-lfs → 图标是指针 → 转图标崩
  （`brew install git-lfs && git lfs pull`）；`prepare:pragent` 的 pip 弱网超时 → `PIP_DEFAULT_TIMEOUT=120` 或配镜像。
- **嵌入式运行时体积大**→ 签名耗时；公开仓库 macOS runner 免费，私有仓库分钟数贵。
- **首次打开（未公证）**：Release 说明需写明绕过方式（右键打开 / 系统设置允许 / `xattr -dr com.apple.quarantine`），
  或提供 Homebrew Cask。
- **升级公证**：见上；同时 mac 段需加回 hardenedRuntime + entitlements + notarize（entitlements 已备好
  `disable-library-validation` 让嵌入式 python 在 hardened runtime 下能加载第三方 dylib）。
