# 打包与发布（构建 / 签名 / CI）

## 职责与边界

把应用 + 嵌入式运行时打成各平台安装包并发布。覆盖 electron-builder 配置、嵌入式运行时随包、
代码签名策略、图标、CI 发布流程。

负责：构建/打包/签名/出包/CI。不负责：嵌入式运行时怎么组装（见 [pr-agent 集成与运行时](../arch/04-pragent-runtime.md)）。macOS 签名细节另见 [macOS 构建与发布](./mac-build.md)。

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

## 发布前置清单（打 tag 前必做）

在**同一批改动**里完成，随发版经 `dev` → `master`——漏任一步 CI 不报错（仅 `::warning::`）但会产出错误的 Release：

1. **版本号** —— 把 [apps/desktop/package.json](../../apps/desktop/package.json) 的 `version` 改成目标版本（去 `v` 前缀，预发布带后缀如 `0.5.0-alpha.1`）。electron-builder 的 `artifactName: code-meeseeks-${version}-...` 直取此值——不改则安装包文件名与 tag 不符。改完 `npm install` 同步 lockfile。
2. **CHANGELOG** —— 把 [CHANGELOG.md](../../CHANGELOG.md) 的 `## [Unreleased]` 改名为 `## [<版本>] - <YYYY-MM-DD>`，并在文件底部补 `[<版本>]: …/compare/…` 链接引用。**发布即消费掉 Unreleased、不留空段**；下一笔开发期 changelog 改动时再新建。release.yml 按 `## [<版本>]` 字面抽段注入 Release 正文——缺段则正文回退、无变更说明。**若正式版内容来自此前的 alpha/预发布**：开发期通常无独立 Unreleased（内容已在预发布段），直接把该预发布段改名为正式版段、删去对应 `[<x>-alpha.N]:` 链接引用（内容并入正式版段，不留空壳 stub）；尚无对应正式版的其它预发布段保留。
3. **校对** —— 确认 `## [<版本>]` 段已覆盖自上版本以来合入 `dev` 的全部要点（新增 / 变更 / 修复）。

tag 名与 package.json 版本必须一致（`v<版本>`）。名含 `-` 的预发布 tag（如 `-alpha.N`）由 release.yml 自动标 prerelease 且不抢占 Latest。

**版本号规则（`-dev`）**：每次正式发版后，`dev` 立即把 [apps/desktop/package.json](../../apps/desktop/package.json) 切到**下一版的 `-dev` 预发布号**（如发完 `0.6.0` 即切 `0.7.0-dev`，`npm install` 同步 lockfile），标记开发态。`-dev` 仅作开发标记——**不打 tag、不发版**；发版时按上面改成目标号（`0.7.0-alpha.N` 或 `0.7.0`）。`-dev` 是合法 semver（`0.6.0` < `0.7.0-dev` < `0.7.0`），不影响更新检测（[update-check.ts](../../apps/desktop/src/main/utils/update-check.ts) 用 `semver.gt` 比对、不用 range）与构建。

## CHANGELOG 撰写风格（面向用户、求简）

- 版本引言 `>` 区直接进入「本版重点」、要点用**无序列表**排版，不堆成长句，**不写「首个 / 第 N 个正式版」之类的版本序数引言**；
- 新增 按**功能场景**分类、用缩进的二级列表表达，每个小点一句话点到即止；
- 重构类任务**前后端合并**为一条总结、不展开实现细节；
- 修复 **不写「怎么修的」机制**，每条一句话只述修复的现象/影响；
- 通篇不写 IPC 通道名、函数名、文件路径、字段名等实现细节，优先突出新增特性与改良；
- **安装 / 升级注意事项**（版本引言里的 ⚠️ 警示，如先卸载旧版、per-machine 提权等）属安全关键信息，**保留完整、不参与精简**——这些会随 release.yml 注入 GitHub Release 正文，删减会让用户漏看升级风险；
- **分段标题用中文 + emoji**：`### ✨ 新增 / ♻️ 变更 / 🔧 修复 / 🗑️ 移除 / 🔒 安全`（对应 Keep a Changelog 的 Added / Changed / Deprecated / Removed / Fixed / Security）；
- 外部贡献者的 PR 习惯性致谢（仿 `(#65，感谢 @user)`）。
