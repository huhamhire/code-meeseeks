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

- [x] 多平台接入：GitHub / Bitbucket / GitLab（含企业自建）
- [x] PR 发现与分类（待我评审 / 我创建 / 指派 / 提及）
- [x] 嵌入式 pr-agent 运行时（免装 Python / Docker）
- [x] 桌面安装包：Windows x64 + macOS arm64
- [x] 出站 HTTP 代理
- [x] 多 LLM Provider 适配 + token 用量采集
- [x] 首启配置向导 + 设置页可视化 CRUD
- [x] 国际化：四语界面（简体中文 / English / 日本語 / Deutsch）
- [x] 高阶 Agent 评审：自主规划 + 多工具编排 + 长期记忆 + 过程可观测
- [x] AutoPilot 预评审：自动预跑评审、准入控制、进应用即见待确认草稿
- [x] 开源发布（Apache-2.0 + NOTICE）

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
