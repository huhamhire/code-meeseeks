# Code Meeseeks Roadmap

> 最后更新：2026-07-03

本文件只保留**高层视角**：已交付能力全景、持续演进、风险与下一步。面向用户的**特性详述**见
**[README](../README.md)**；各模块的**设计与实现细节**见 **[模块设计文档 docs/arch/](arch/README.md)**。

## 1. 项目定位

面向 Reviewer **个人**的本地化、半自动化代码评审 GUI 客户端，基于社区版
[pr-agent](https://docs.pr-agent.ai/) 构建，核心立场是**决策权在人、规则在本地、数据在本地**。

> 完整定位、适用 / 不适用场景见 **[README](../README.md)**，此处不再重复。

---

## 2. 已交付能力

> 按 README「核心特性」的领域划分组织，此处为**交付全景**（高层）；面向用户的特性详述见 README。

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
- [x] CLI 模式 `/ask` 仓库文件访问：一次性 worktree 取完整上下文 + 落 cwd 前清洗仓库自带 agent 指令文件防注入（见 [06](arch/06-agent.md)）

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
- [x] 开源发布（Apache-2.0 + NOTICE）

---

## 3. 持续演进

开放的持续阶段，不设单一 Done when。

### 进行中 / 待办 ⏭️

- [ ] **可观测性扩展**：规则命中率、模型对比（token 用量已做）。

### 0.10.0：项目国际化与品牌官网 🌐

本轮聚焦「项目自身」的对外呈现（区别于**应用界面** i18n，后者已四语交付），分**品牌官网**与**文档国际化**两条线。

**A. 品牌官网**（技术栈 **VitePress**；英文默认 + 中文；源码置主仓 `website/`）

- [ ] 落地页：定位一句话 + 截图 / 演示 + 核心特性（镜像 README 领域划分，营销化改写）+ 下载 CTA（跳 Releases）+ FAQ
- [x] 托管使用文档：官网从仓库 `docs/guide/` 构建渲染（**不另起一份**），i18n 走 VitePress `locales`（EN 根 + `/zh/`）
- [ ] 部署：GitHub Pages（source 选 GitHub Actions），新增独立 `pages.yml`（路径过滤 `website/**` + `docs/**`，push `master` 触发），**与 `release.yml` 的 `v*` 发版流水线解耦**
- [ ] 自定义域名（可选，后续 `CNAME`）

**B. 文档国际化**（英文默认 + 中文；`arch/` 与 `ROADMAP` 维持中文、不纳入本轮）

- [ ] **阶段 1（本轮）**：README 拆分 —— `README.md`（英文，默认）+ `README.zh-CN.md`（中文），两份顶部各置语言切换行；现有中文 README 迁至 `README.zh-CN.md`
- [x] **阶段 2**：`docs/guide/` 用户向文档 EN + ZH——英文占根（规范正本），中文镜像于 `zh-CN/`，每篇置语言切换行；官网 `sync-docs.mjs` 双 locale 构建（EN→`/guide/`、ZH→`/zh/guide/`）
- [x] **阶段 3**：开发/贡献者向英文化——`docs/development/` 转英文单语 + 新增英文 `CONTRIBUTING.md`（贡献者入口）；commit / PR 约定改用英文（见 [AGENTS](../AGENTS.md)）。`docs/arch/` 与本 ROADMAP 仍维持中文（设计推演工作稿、随代码高频变动，成本高 / 外部读到概率低，等外部贡献者信号出现再单独评估）

**内容同步规范**（防 README / docs / 官网三处漂移，每类内容单一真相源）：

| 内容 | 真相源 (SoT) | 其余处理 |
| --- | --- | --- |
| 定位 / 核心特性 | README | 官网落地页在营销高度改写，细节链回 README/docs，不逐字复制 |
| 使用文档 | 仓库 `docs/guide/` | 官网从其构建渲染，不另存一份 |
| arch 设计文档 | 仓库 `docs/arch/`（中文） | 不进官网、不翻译（与「设计文档中文、异常/日志英语」约定一致） |

---

## 4. 风险与未决项

| 风险 / 议题               | 应对                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| pr-agent 升级破坏输出格式 | 输出解析层独立（parse-output 单测进 CI）+ shim 构建期 / 运行期版本守卫（见 [04](arch/04-pragent-runtime.md)）+ 构建期冒烟（import / 补丁 / litellm，release）；升级 pin 时人工刷样本重验 |
| 大型 PR 性能 / diff 截断  | Diff 走本地 git（不用平台截断端点）+ Monaco 懒加载 + 大文件跳过（见 [02](arch/02-repo-mirror.md)） |
| 大型仓库挤爆磁盘          | `repos_dir` 可配置 + 设置页显示体积 + 清理                                                         |
| 明文凭据（config.yaml）   | 文件权限收紧 + 文档警示 + `SecretStore` 抽象预留（keytar 升级暂无计划，见 [08](arch/08-config-and-secrets.md)）  |
| JSON 状态文件膨胀         | 监控单文件大小；评估后维持 JSON（SQLite 为备选，暂不切，见 [03](arch/03-state-storage.md)）        |
| LLM 调用成本              | token 用量统计已做；规则层可控 max_tokens / 模型分级                                               |
