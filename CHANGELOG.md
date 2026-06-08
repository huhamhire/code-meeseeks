# 更新日志（Changelog）

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

（暂无）

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

> 首个公开预览版（0.x · 早期预览）。面向 **Reviewer 个人** 的本地化、半自动 AI 代码评审桌面客户端，
> 基于社区版 [pr-agent](https://docs.pr-agent.ai/) 构建：拉取待评审 PR、本地跑 AI 生成评审意见，
> 逐条确认 / 编辑后再发布到代码平台。**决策权在人、规则在本地、数据在本地。**

### 平台接入与 PR 发现
- Bitbucket Server / Data Center 接入（REST API v1，>= 7.0）。
- 轮询自动发现作为 Reviewer 的待评审 Open PR；按仓库分组、状态过滤、搜索。
- 首启配置向导：引导配置代码平台连接 +（可选）LLM。
- 单例锁：二次启动聚焦已有窗口，不再多开。

### 本地 Diff 阅读
- bare 镜像（按需 clone / fetch）+ Monaco 并排 / 内联 diff。
- 文件树、行内评论、git blame、跨文件代码搜索。
- GitHub 风格未变更段折叠。

### AI 评审（pr-agent）
- 对话式驱动 `/describe`、`/review`、`/ask`，输出结构化成可操作的 findings。
- 评审任务队列：串行执行、随时取消、失败重试。
- `/review` finding 行号锚点根因修复（注入 get_line_link，从结构化输出取 file:line）。
- 真实 token 用量采集（输入 / 输出分列）。

### 评审 → 发布闭环
- findings → 草稿池 → 行内编辑（Monaco view zone）→ 单条 / 批量发布到远端。
- 发布后远端评论自动刷新；重复发布幂等（发完即删本地草稿）。
- 自己作者的远端评论支持回复 / 编辑 / 删除。
- 远端可合并时一键合并 PR。

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

### 隐私与数据
- 本地优先：除调用所配置的 LLM API 与代码平台外不向第三方上报数据。
- 配置 / 状态 / 日志固定在 `~/.code-meeseeks/`；仓库镜像目录可配置。

---

许可证：[Apache-2.0](LICENSE)。打包内含第三方组件（pr-agent、Electron 等），各按其许可证分发，见 [NOTICE](NOTICE)。

[Unreleased]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/releases/tag/v0.1.0-alpha.1
