# Code Meeseeks Roadmap

> 最后更新：2026-06-16
> 状态：**M0–M4 已交付**；**M5（打磨 + 多平台扩展）持续中**。GitHub / Bitbucket / **GitLab** Adapter 均已交付（GitLab：CE / EE，gitlab.com + Self-Managed）。**高阶 Agent 评审 + AutoPilot 预评审已交付**。
>
> **命名约定**：对外品牌 **Code Meeseeks**（灵感来自 Rick and Morty 的 Mr. Meeseeks）；代码内部
> 统一用中性代号 **meebox**（npm 作用域 `@meebox/*`，数据目录 `~/.code-meeseeks`）。pr-agent 为
> 第三方依赖，不在重命名范围内。

本文件只保留**高层视角**：里程碑状态、风险、下一步。各模块的**设计与实现细节**见
**[模块设计文档 docs/arch/](arch/README.md)**。

## 1. 项目定位

面向 Reviewer **个人**的本地化、半自动化代码评审 GUI 客户端，基于社区版
[pr-agent](https://docs.pr-agent.ai/) 构建，核心立场是**决策权在人、规则在本地、数据在本地**。

> 完整定位、适用 / 不适用场景、核心特性见 **[README](../README.md)**，此处不再重复。

---

## 2. 里程碑进度

每一期都设计为**可独立交付**的里程碑。实现细节见对应模块文档。

| 里程碑                    | 状态 | 交付摘要                                                                   |
| ------------------------- | ---- | -------------------------------------------------------------------------- |
| **M0** 工程基线           | ✅   | 单仓多包（npm + Nx）+ Electron 壳 + 类型化 IPC + 工作目录 bootstrap + CI   |
| **M1** 平台接入 + PR 发现 | ✅   | Bitbucket Server adapter + 轮询发现 + PR 列表 / 分组 / 过滤 UI             |
| **M2** 仓库镜像 + Diff    | ✅   | bare 镜像 + Monaco 并排 diff + 文件树 + 行内评论 + blame                   |
| **M3** pr-agent 集成      | ✅   | bridge + `/describe`·`/review`·`/ask` + 输出解析 + rules 注入 + 对话式队列 |
| **M4** 评审 → 发布闭环    | ✅   | findings → 草稿池 → 内联编辑 → 批量发布 + 评论 reply/edit/delete + 合并    |
| **M5** 打磨 + 多平台      | 🔄   | 持续，见 §3                                                                |

> 详细设计：平台适配见 [01](arch/01-platform-adapter.md)、仓库镜像见 [02](arch/02-repo-mirror.md)、
> 状态存储见 [03](arch/03-state-storage.md)、pr-agent 运行时见 [04](arch/04-pragent-runtime.md)、
> 评审闭环见 [05](arch/05-review-workflow.md)、规则见 [07](arch/07-rules.md)、配置见 [08](arch/08-config-and-secrets.md)。

---

## 3. M5 · 打磨与多平台扩展（持续）

开放的持续阶段，不设单一 Done when。

### 已交付 ✅（截至 2026-06-16）

- [x] **GitHub Adapter**：github.com + GitHub Enterprise Server（REST API v3）；统一 `PlatformAdapter`
  契约 + 一致性测试套件；PR 发现分类（待我评审 / 我创建 / 指派 / 提及，本地缓存按标记过滤）。
  Bitbucket 同步提供「待我评审 / 我创建」两类。
- [x] **GitLab Adapter**：gitlab.com + Self-Managed（CE / EE，REST API v4）；复用 `PlatformAdapter` 契约
  + 一致性测试套件。MR 发现（待我评审 / 我创建 / 指派）、diff 评论读写、合并、clone、头像 / 图片代理；
  经 `/metadata` 探测 edition，审批能力按 CE / EE 降级（详见 [docs/arch/01-platform-adapter.md](arch/01-platform-adapter.md) §4.3）。
- [x] 嵌入式 pr-agent 运行时打包（内嵌 Python，免装 Python/Docker）；**移除 Docker 运行策略**（容器装载效率低、与「零依赖」定位不符，embedded / local-cli 已覆盖全部场景）
- [x] 首发桌面安装包：Windows x64（NSIS）+ macOS arm64（dmg，ad-hoc 签名）
- [x] 出站 HTTP 代理（LLM / 代码平台 / git HTTPS 统一，loopback 直连）
- [x] `/review` finding anchor 根因修复（get_line_link 注入）
- [x] 多 LLM Provider 适配 + 实测验证（openai / anthropic / deepseek / dashscope / volcengine-ark）
- [x] 真实 token 用量采集（输入 / 输出分列）
- [x] 首启配置向导
- [x] 设置页连接 / LLM / 代理可视化 CRUD
- [x] 单例锁（二次启动聚焦已有窗口）
- [x] 开源发布准备（README + 开发指南 + Apache-2.0 + NOTICE）
- [x] **国际化（i18n）**：四语界面（简体中文 / English / 日本語 / Deutsch），AI 回复语言随界面语言
- [x] **高阶 Agent 评审**（设计见 [06](arch/06-agent.md)）：对话 Agent 化（自然语言 → 自主规划 + 多工具编排）；分层 Agent 目录（`SOUL` / `AGENTS` / `MEMORY` / `USER` / `rules`）+ 长期记忆；过程可观测（think → tool → think 时间线、逐步计时）、可随时停止。配置由 `rules.*` 迁移为 `agent.*`，原 `rules.dir` 并入 `<agent.dir>/rules/`（不做兼容，首启向导给出迁移指引）。
- [x] **AutoPilot 预评审**（设计见 [06](arch/06-agent.md)）：轮询发现待评审 PR 后规划 agent 批量判定 → 各 PR 子 agent 自动预跑 `/describe` + `/review`（严重问题条件追问 + 逐 PR 总结 / 建议）；准入控制（仅「待我评审·待处理」、跳过已评审、PR 移除 / purge 即终止在途任务）、评估周期对齐轮询间隔、多 PR 并发以填满工具队列；进应用即见待确认草稿（决策权仍在评审者），状态栏开关默认关。

### 进行中 / 待办 ⏭️

- [ ] **CLI 模式下 /ask 仓库文件访问**（设计见 [06](arch/06-agent.md)）：CLI 模式（claude/codex）现把工具子进程落在中性临时目录（避免被评审仓库的 `CLAUDE.md`/`AGENTS.md` 污染输出），故 /ask 只能基于 diff 推理、读不到完整文件。计划仅对 /ask 提供 worktree 工作目录（如经 `MEEBOX_CLI_WORKDIR` env 让 shim 按工具切 cwd，describe/review 维持中性），在"更全的文件上下文"与"仓库自带指令污染"间取舍；或评估 `--add-dir` 只读授权方案。API 模式不涉及（远程接口本就只有 diff）。
- [ ] **规则市场**：导入 / 导出规则片段（`<agent.dir>/rules/`）。
- [ ] **可观测性扩展**：规则命中率、模型对比（token 用量已做）。
- [ ] **大 PR 性能验证**：等真实大样本实测。
- [ ] **凭据存储升级 keytar** / **状态存储按需升级 SQLite**（替换抽象实现，业务不变）。
- [ ] **CI 自动出包（Win + mac）**：当前手工触发；仅计划 Windows + macOS，暂不出 Linux。

---

## 4. 风险与未决项

| 风险 / 议题               | 应对                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| pr-agent 升级破坏输出格式 | 输出解析层独立 + shim 版本守卫（见 [04](arch/04-pragent-runtime.md)）；CI 跑兼容测试               |
| 大型 PR 性能 / diff 截断  | Diff 走本地 git（不用平台截断端点）+ Monaco 懒加载 + 大文件跳过（见 [02](arch/02-repo-mirror.md)） |
| 大型仓库挤爆磁盘          | `repos_dir` 可配置 + 设置页显示体积 + 清理                                                         |
| 明文凭据（config.yaml）   | 文件权限收紧 + 文档警示 + `SecretStore` 抽象预留 keytar（见 [08](arch/08-config-and-secrets.md)）  |
| JSON 状态文件膨胀         | 监控单文件大小；触发条件达成切 SQLite（见 [03](arch/03-state-storage.md)）                         |
| LLM 调用成本              | token 用量统计已做；规则层可控 max_tokens / 模型分级                                               |

---

## 5. 相关文档

- **[模块设计文档](modules/README.md)** —— 各模块的当前设计与实现（首选入口）
- [开发指南](development/README.md) —— 环境、启动、构建（开发专题入口）
- [打包与发布](development/packaging-release.md) —— 构建 / 签名 / CI
- [macOS 构建与发布](development/mac-build.md) —— ad-hoc 签名路线
