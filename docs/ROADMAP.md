# Code Meeseeks Roadmap

> 最后更新：2026-07-05

> 面向用户的**特性详述**见 **[README](../README.md)**。
>
> 各模块的**设计与实现细节**见 **[模块设计文档 docs/arch/](arch/README.md)**。

## 1. 已交付能力

#### 🌍 多平台接入

- [x] 统一接入 GitHub / Bitbucket / GitLab（含 GitHub Enterprise / GitLab Self-Managed，按平台能力自适应降级）
- [x] 本地优先：仓库副本 / PR 元数据 / 草稿存本机；内嵌 pr-agent 运行时，免装 Python / Docker
- [x] 出站 HTTP 代理（本地地址自动直连）

#### 📥 PR 发现与浏览

- [x] 轮询自动发现 + 分类（待我评审 / 我创建 / 指派 / 提及）+ 仓库分组 + 状态过滤 + 搜索
- [x] 未读与点名标记（新分配 / 新提交 / 被 @ / 被回复；被点名条数单独计数）
- [x] 历史归档浏览 + 按 URL 打开任意 PR（含补充评论、补跑评审）

#### 🔍 本地 Diff 阅读

- [x] 并排 / 内联 diff、文件树（合并冲突标注）、按变更范围 / 单 commit、总览标尺、blame、跨文件搜索
- [x] 行内评论（新增行与删除行均可）+ 选中代码作上下文引用

#### 🤖 AI / Agentic 评审

- [x] 指令驱动 pr-agent（`/describe`·`/review`·`/improve`·`/ask`），结果结构化成可操作的评审发现
- [x] 复评闭环：对评审发现发起 `/ask` 复评，按裁决（取代 / 保留 / 撤销）自动处理原评论
- [x] Agentic 自主规划 + 多工具编排 + 长期 Memory + 过程可观测，可中途追加输入、随时停止
- [x] AutoPilot 预评审：对待我评审·待处理的新 PR 自动预跑，准入控制 + 逐项授权 + 红线校验（默认仅只读工具）
- [x] CLI 模式 `/ask` 仓库文件访问：一次性 worktree 取完整上下文 + 落 cwd 前清洗仓库自带 agent 指令文件防注入（见 [agent 设计](arch/02-agent/01-agent.md)）

#### ✍️ 评审闭环与协作

- [x] 评审发现 → 草稿池 → 内联编辑 → 单条 / 批量发布；远端可合并状态可视 + 一键合并（亦可 `/merge`）
- [x] 评论互动：回复 / 编辑 / 删除 + emoji 反应 + @ 提及补全 + 图片附件 + `:shortcode:` 表情渲染（随平台能力）
- [x] 活动时间线：评论 / 提交更新 / 评审决断归并为一条（GitHub / Bitbucket）
- [x] 消息通知：新 PR / 评论回复 / 被 @ 分类系统通知（仅待处理 PR）+ 点击直达 PR / 代码行 + macOS dock 角标 + macOS 授权引导

#### ⚙️ 模型与规则

- [x] 多 LLM Provider（OpenAI / openai-compatible / DeepSeek / Anthropic / 通义千问 / 火山方舟等；本地 CLI claude·codex）+ token 用量采集
- [x] 个性化规则目录（markdown + frontmatter，子目录递归；命中多条按 Ruleset 分段注入、`priority` 排序）
- [x] 运行参数可调：评审任务并发、输入上下文长度、Agent 策略（自动追问开关、代码建议数量）

#### 🔌 外部集成与 CLI

- [x] 本机本地 API（仅本机可达 + 令牌鉴权）开放 PR 发现 / 浏览 / diff / 评审 Agent / 评审写动作，供外部 agent · 脚本 · CI 集成
- [x] 跨平台 CLI `meebox`（Windows / macOS / Linux）：浏览 PR + 驱动评审 Agent + 评审写动作（approve / needswork / comment）；压缩包即 agent skill 目录

#### 🎨 界面与体验

- [x] 主题与外观：深色 / 浅色 / 跟随系统 + 多款编辑器配色 + 自定义等宽字体字号
- [x] 命令面板（`Ctrl/Cmd+Shift+P`）归口分散功能 + 全局快捷键
- [x] 四语界面（简体中文 / English / 日本語 / Deutsch），AI 回复语言随界面语言
- [x] 无边框自绘标题栏 + 首启配置向导 + 设置页可视化 CRUD

#### 📦 工程与发布

- [x] 单仓多包（npm + Nx）+ Electron + 类型化 IPC + CI（lint / typecheck / test / build）
- [x] 桌面安装包 Windows x64 + macOS arm64；CI 按 `v*` tag 自动出包并发 GitHub Release（暂不出 Linux）
- [x] 品牌官网（VitePress，英文默认 + 中文，GitHub Pages 独立部署、与发版流水线解耦）+ 项目对外文档双语（README / 使用文档：英文正本 + 中文镜像）
- [x] 开源发布（Apache-2.0 + NOTICE）

---

## 2. 持续演进

开放的持续阶段，不设单一 Done when。

### 进行中 / 待办 ⏭️

- [ ] **可观测性扩展**：规则命中率、模型对比（token 用量已做）。

---

## 3. 风险与未决项

| 风险 / 议题               | 应对                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| 明文凭据（config.yaml）   | 文件权限收紧 + 文档警示 + `SecretStore` 抽象预留（keytar 升级暂无计划，见 [配置与密钥](arch/99-core/02-config-and-secrets.md)）  |
| LLM 调用成本              | token 用量统计已做；规则层可控 max_tokens / 模型分级                                               |
