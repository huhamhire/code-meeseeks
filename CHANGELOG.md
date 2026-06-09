# 更新日志（Changelog）

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0-alpha.1] - 2026-06-09

### Added
- **多平台适配抽象基线**：`PlatformAdapter` 能力描述符（`capabilities()`）、`PrDiffRefs`、
  `PrComment` 线程字段（kind / threadId / nativeId），为接入新平台铺底；UI 据能力位 显 / 隐 / 灰，
  不在调用处写 `if (platform === ...)`。
- **GitHub 适配**（github.com + GitHub Enterprise Server，REST API v3）：PR 发现、diff 评论读写、
  行内评论、审批（通过 / 需修改 / 撤销）、合并；设置页与首启向导可新增 GitHub 连接，连接配置中置顶。
  审批按平台能力降级：不支持的决断隐藏，自己作者的 PR 审批按钮灰显（不能审批自己）。GitHub Base URL
  可选，留空默认 `api.github.com`。
- **PR 发现分类**：GitHub 对齐仪表盘四类（待我评审 / 我创建 / 指派我 / 提及我）；Bitbucket 增
  「待我评审 / 我创建」两类。能力驱动 + 分类结果本地缓存，渲染层按标签本地过滤。
- **单活动连接模型**：PR 列表与状态栏只反映当前活动连接；切换活动连接后归档旧连接的 PR，使其进入 purge 路径。
- **本地 CLI 模型 provider**（`cli`）：不直连模型 API，把评审请求转交本机已安装并授权的命令行工具
  （Claude Code / Codex CLI）代为调用第三方模型；其凭据与计费由该 CLI 自理。
- 合并按钮等待态，防止重复点击。
- **评审任务并发执行**：队列从单并发改为可配置并发（每个 run 独立 worktree + 独立子进程，
  并发安全），多个 PR 的 review 可并行跑、互不阻塞。并发数由 `pr_agent.max_concurrency`
  控制（1~8，默认 2，高级参数仅 config.yaml 手改、不在设置页暴露）。chat 与状态栏支持多条
  运行中展示。
- 新增面向用户的**使用说明**文档（`docs/guide/`，序号命名 + 索引）：安装与首次使用、代码平台配置、
  LLM 配置（含本地 CLI 模式）、网络代理配置。

### Changed
- 全仓内部命名统一为 **Bitbucket**，去除 `BBS` / `BB` 等歧义缩写（纯改名，无行为变化）。
- 架构设计文档目录 `docs/modules/` → `docs/arch/`，统一定位为「架构设计文档」。
- **日志增强**：dev 控制台改 logfmt 单行（`<ISO8601> LEVEL msg="…" k=v`，含 msg 在内全部字段
  统一 kv、按级别上色，文件仍为 JSON）；渲染层未捕获错误 / rejection 经 IPC 回传 main，
  与主进程崩溃兜底一并落进 `meebox.log`。
- **启动提速**：
  - 新增启动闪屏（splash）：独立轻量窗口几十 ms 即呈现品牌 logo + 名称 + spinner，
    遮住主窗口首帧前的渲染层加载空窗；主窗口首帧就绪即关闭、无缝切入。
  - Monaco 编辑器（~7.3MB）改为懒加载——DiffView / InlineCodeContext 经 `React.lazy`
    按需拉取，渲染入口包从 ~10MB 降到 ~2.6MB，窗口外壳（加载页 / 首启向导 / PR 列表）
    不再等 Monaco 解析即可呈现；首次看 diff 时才加载，首启无连接时完全不加载。
  - pr-agent 探测移出建窗关键路径，改为与窗口加载并发执行（过去探测回退超时会把首帧
    整体推迟数秒）；探测结果就绪后回填。

### Removed
- **移除 Docker 运行策略**：容器文件系统装载效率低、与「零依赖」定位不符；嵌入式运行时
  （默认）+ 系统 local-cli 已覆盖全部场景。`pr_agent.strategy` 不再接受 `docker`。

### Fixed
- 修复模型返回多行自由文本值（如中文 `issue_content`）未用块标量、续行顶格导致 pr-agent
  `load_yaml` 解析失败、整个 `/review` 崩溃（`NoneType is not iterable`）：`sitecustomize`
  在解析失败时重排为块标量后重试。

### Security
- GitHub 图片代理仅对可信的 GitHub / GHE 资产域附带 PAT，避免凭据被带往第三方域。

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

[Unreleased]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0-alpha.1...HEAD
[0.2.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0-alpha.1
[0.1.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/releases/tag/v0.1.0-alpha.1
