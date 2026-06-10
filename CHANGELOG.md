# 更新日志（Changelog）

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- **Mermaid 图渲染**：markdown 里的 ```mermaid``` 代码块（Qodo `/describe` 常生成的架构图）渲染为图形，
  覆盖 PR 描述 / 评论 / chat 评审输出。mermaid 懒加载（独立 chunk，仅出现图表时才拉取，不进入口包）；
  深色主题、`securityLevel: strict`，渲染失败回退原始代码块。
- **版本更新检测**：启动时（及设置页「检查更新」）查 GitHub Releases 最新稳定版与当前版本比对，
  有新版在状态栏提示并可点击前往下载（仅检测 + 提示，不自动下载 / 安装）。检测走配置的出站代理
  （内网友好），可经 `update.check_enabled` 关闭。
- **/describe 架构图**：嵌入式 pr-agent 统一启用 GFM（shim 让本地 provider 支持 gfm_markdown），
  使社区版 `/describe` 的 `enable_pr_diagram`（默认开）按实际改动**选择性输出 mermaid 架构图**，
  配合 Mermaid 渲染直接成图；`/review` 等同步走 GFM 富 markdown，输出解析（parse-output）相应
  兼容 GFM 的 `<table>` / `<details>` / `<a href>` finding 形态。
- **describe 排版优化**：架构图、文件变更各自独立成段，配中文色块标题（「架构图」/「文件变更」）；
  文件变更保留多级分类、每个分类独立成可收起/展开的折叠块（去掉无意义的 +1/-1 统计）；
  mermaid 图点击进入模态预览，支持滚轮缩放、拖拽平移与「适应窗口」，预览区为固定纯色背景。
- **清空执行历史**：chat 面板标题栏新增垃圾桶按钮，清空**当前 PR**的 PR Agent 执行历史记录（仅该 PR）。
- **启用 `/improve` 指令**：逐行代码改进建议（带 1-10 重要度评分）。依托 shim 的 GFM 支持走
  「汇总建议」路径（committable/inline 模式在本地 provider 下不可用，已显式关死兜底）；输出落
  独立 `improve.md` 与 `/review` 分流（经 `local.review_path` 原生配置）；关闭 persistent_comment
  避免本地 provider 翻历史评论刷无意义 traceback。

## [0.2.0] - 2026-06-09

> 第二个正式版（仍属 0.x · 早期预览）。本版重点：**接入 GitHub**（github.com + GitHub Enterprise Server）
> 与多平台适配抽象、**评审任务并发执行**、**启动显著提速**，并**移除 Docker 运行策略**收敛到内嵌运行时。
> 开发期 0.2.0-alpha.1 / alpha.2 的变更已并入本版。

### Added
- **GitHub 适配**（github.com + GitHub Enterprise Server，REST API v3）：PR 发现、diff 评论读写、
  行内评论、审批（通过 / 需修改 / 撤销）、合并；设置页与首启向导可新增 GitHub 连接，连接配置中置顶。
  审批按平台能力降级：不支持的决断隐藏，自己作者的 PR 审批按钮灰显。GitHub Base URL 可选，留空默认
  `api.github.com`。
- **多平台适配抽象基线**：`PlatformAdapter` 能力描述符（`capabilities()`）、`PrDiffRefs`、`PrComment`
  线程字段（kind / threadId / nativeId）；UI 据能力位 显 / 隐 / 灰，不在调用处写 `if (platform === ...)`。
- **PR 发现分类**：GitHub 对齐仪表盘四类（待我评审 / 我创建 / 指派我 / 提及我）；Bitbucket 增
  「待我评审 / 我创建」两类。能力驱动 + 分类结果本地缓存，渲染层按标签本地过滤。
- **单活动连接模型**：PR 列表与状态栏只反映当前活动连接；切换活动连接后归档旧连接的 PR。
- **评审任务并发执行**：队列从单并发改为可配置并发（每个 run 独立 worktree + 独立子进程，并发安全），
  多个 PR 的 review 可并行、互不阻塞。并发数由 `pr_agent.max_concurrency` 控制（1~8，默认 2，仅
  config.yaml 手改）。同一 PR 同一工具运行 / 排队中禁止重复触发（`/ask` 不限）。
- **本地 CLI 模型 provider**（`cli`）：不直连模型 API，把评审请求转交本机已安装并授权的命令行工具
  （Claude Code / Codex CLI）执行评审；其凭据与计费由该 CLI 自理。
- 合并按钮等待态，防止重复点击。
- 新增面向用户的**使用说明**文档（`docs/guide/`，序号命名 + 索引）：安装与首次使用、代码平台配置、
  LLM 配置（含本地 CLI 模式）、网络代理、**配置文件参考**、**自定义评审规则**。

### Changed
- 全仓内部命名统一为 **Bitbucket**，去除 `BBS` / `BB` 等歧义缩写（纯改名，无行为变化）。
- 架构设计文档目录 `docs/modules/` → `docs/arch/`，统一定位为「架构设计文档」。
- **启动提速**：新增启动闪屏（splash）即时呈现品牌 logo + spinner；Monaco（~7.3MB）改 `React.lazy`
  懒加载，渲染入口包 ~10MB → ~2.6MB，窗口外壳不再等 Monaco 解析；pr-agent 探测移出建窗关键路径
  并发执行。
- **日志增强**：dev 控制台改 logfmt 单行（`<ISO8601> LEVEL msg="…" k=v`，按级别上色，文件仍 JSON）；
  渲染层未捕获错误 / rejection 经 IPC 回传 main，与主进程崩溃兜底一并落进 `meebox.log`。

### Removed
- **移除 Docker 运行策略**：容器文件系统装载效率低、与「零依赖」定位不符；嵌入式运行时（默认）+
  系统 local-cli 已覆盖全部场景。`pr_agent.strategy` 不再接受 `docker`。

### Fixed
- 修复模型返回多行自由文本值（如中文 `issue_content`）未用块标量、续行顶格导致 pr-agent `load_yaml`
  解析失败、整个 `/review` 崩溃（`NoneType is not iterable`）：`sitecustomize` 在解析失败时重排为块标量后重试。
- 修复 pr-agent `get_diff_files` 对删除文件 filename 取空导致行号片段渲染崩溃（回退取 `a_path`）。
- 修复首启向导平台卡视觉错位：GitHub 副标题缩短避免换行、图标固定宽度、文字在图标右侧区域居中。

### Security
- GitHub 图片代理仅对可信的 GitHub / GHE 资产域附带 PAT，避免凭据被带往第三方域。
- 升级 `nx` 至 22.7.5 并在范围内修复 `minimatch`，消除 `minimatch` ReDoS（high）依赖告警。

## [0.2.0-alpha.2] - 2026-06-09

> 开发期预览版。其全部变更内容已并入正式版 **[0.2.0](#020---2026-06-09)**，此处不再展开。

## [0.2.0-alpha.1] - 2026-06-09

> 开发期预览版。其全部变更内容已并入正式版 **[0.2.0](#020---2026-06-09)**，此处不再展开。

## [0.1.0] - 2026-06-08

> 首个正式版（仍属 0.x · 早期预览）。面向 **Reviewer 个人** 的本地化、半自动 AI 代码评审桌面客户端，
> 基于社区版 [pr-agent](https://docs.pr-agent.ai/) 构建：拉取待评审 PR、本地跑 AI 生成评审意见，
> 逐条确认 / 编辑后再发布到代码平台。**决策权在人、规则在本地、数据在本地。**

### 平台接入与 PR 发现
- Bitbucket Server / Data Center 接入（REST API v1，>= 7.0）。
- 轮询自动发现作为 Reviewer 的待评审 Open PR；按仓库分组、状态过滤、搜索。
- 首启配置向导：引导配置代码平台连接 +（可选）LLM；缺有效连接时下次启动仍回向导。
- 单例锁：二次启动聚焦已有窗口，不再多开。

### 本地 Diff 阅读
- bare 镜像（按需 clone / fetch）+ Monaco 并排 / 内联 diff。
- 文件树、行内评论、git blame、跨文件代码搜索。
- GitHub 风格未变更段折叠。

### AI 评审（pr-agent）
- 对话式驱动 `/describe`、`/review`、`/ask`，输出结构化成可操作的 findings。
- 评审任务队列：串行执行、排队任务在 chat 内可见、随时取消、失败重试。
- `/review` finding 行号锚点根因修复（注入 get_line_link，从结构化输出取 file:line）；finding 锚点可点击跳转到 Diff 对应行。
- 真实 token 用量采集（输入 / 输出分列）。
- LLM 未配置时 chat 面板给出明确提示并禁用输入。

### 评审 → 发布闭环
- findings → 草稿池 → 行内编辑（Monaco view zone）→ 单条 / 批量发布到远端。
- 发布后远端评论自动刷新；重复发布幂等（发完即删本地草稿）。
- 自己作者的远端评论支持回复 / 编辑 / 删除。
- 远端可合并时一键合并 PR；审批 / 合并远端失败时弹 toast 提示，不再静默。

### 个性化规则
- 每位 Reviewer 维护自己的规则目录（markdown + frontmatter），按项目 / 仓库 / 目标分支命中后注入评审。

### 多 LLM Provider
- 适配并实测验证：OpenAI、Anthropic、DeepSeek、阿里百炼（通义千问）、火山方舟（豆包）。
- 厂商原厂模型只填型号名即用（按 provider 自动补 litellm 前缀）。
- ollama / openai-compatible 理论可行（待验证）。
- 设置页连接 / LLM / 代理可视化 CRUD（草稿态「写入不启用」，保存或显式启用才应用）。
- 出站 HTTP 代理：LLM 调用 / 代码平台 / git HTTPS 统一走代理，本地地址自动直连。

### 运行时与打包
- 内嵌可重定位 Python + 固定版本 pr-agent，开箱即用，无需自装 Python / Docker（Docker 模式可选）。
- 桌面安装包：Windows x64（NSIS）、macOS arm64（dmg，ad-hoc 签名、未公证）。
- `sitecustomize` 无侵入补丁体系（带版本守卫）：二进制安全 diff、Anthropic 新模型去 `temperature`、
  YAML 容错（anchor marker 不破坏解析）、token 用量采集等。
- 修复：只读安装目录（如 `C:\Program Files`）下缺 `.secrets.toml` 导致的 pr-agent 启动告警 —— 占位文件改为组装期烤入随包分发。

### 隐私与数据
- 本地优先：除调用所配置的 LLM API 与代码平台外不向第三方上报数据。
- 配置 / 状态 / 日志固定在 `~/.code-meeseeks/`；仓库镜像目录可配置。

## [0.1.0-alpha.1] - 2026-06-07

> 首个公开预览版。其全部变更内容已并入正式版 **[0.1.0](#010---2026-06-08)**，此处不再重复展开。

---

许可证：[Apache-2.0](LICENSE)。打包内含第三方组件（pr-agent、Electron 等），各按其许可证分发，见 [NOTICE](NOTICE)。

[Unreleased]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0
[0.2.0-alpha.2]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0-alpha.1
[0.1.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/releases/tag/v0.1.0-alpha.1
