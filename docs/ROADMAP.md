# Code Meeseeks Roadmap

> 最后更新：2026-06-07
> 状态：**M0–M4 已交付**；**M5（打磨 + 多平台扩展）持续中**。下一步主线：**GitHub Adapter**。
>
> **命名约定**：对外品牌 **Code Meeseeks**（灵感来自 Rick and Morty 的 Mr. Meeseeks）；代码内部
> 统一用中性代号 **meebox**（npm 作用域 `@meebox/*`，数据目录 `~/.code-meeseeks`）。pr-agent 为
> 第三方依赖，不在重命名范围内。

本文件只保留**高层视角**：定位、里程碑状态、风险、下一步。各模块的**设计与实现细节**见
**[模块设计文档 docs/modules/](modules/README.md)**。

## 1. 项目定位

**Code Meeseeks**（代号 meebox）是面向 Reviewer **个人**的本地化、半自动化代码评审 GUI 客户端，
基于社区版 [pr-agent](https://docs.pr-agent.ai/) 构建。

- **决策权在人**：所有评论必须经评审者二次确认 / 编辑后才发布到远端。
- **规则在本地**：每位评审者配置自己的检查规则、风格偏好、LLM Provider。
- **数据在本地**：仓库副本、PR 元数据、评论草稿都保存在本地工作目录，企业内网友好。

### 1.1 目标用户

- 需要承担 code review 的工程师 / Tech Lead
- 希望用 AI 加速评审，但不愿把决策权完全交给 bot
- 多在企业内网，使用自建 Bitbucket / GitLab

### 1.2 非目标

- ❌ 不是 CI 上跑的自动化 review bot（那是 pr-agent 本身的定位）
- ❌ 不是团队协同评审平台，不做服务端、不做多用户同步
- ❌ 不替代代码托管平台原生的评审 UI

---

## 2. 里程碑进度

每一期都设计为**可独立交付**的里程碑。实现细节见对应模块文档。

| 里程碑 | 状态 | 交付摘要 |
| --- | --- | --- |
| **M0** 工程基线 | ✅ | 单仓多包（npm + Nx）+ Electron 壳 + 类型化 IPC + 工作目录 bootstrap + CI |
| **M1** 平台接入 + PR 发现 | ✅ | Bitbucket Server adapter + 轮询发现 + PR 列表 / 分组 / 过滤 UI |
| **M2** 仓库镜像 + Diff | ✅ | bare 镜像 + Monaco 并排 diff + 文件树 + 行内评论 + blame |
| **M3** pr-agent 集成 | ✅ | bridge + `/describe`·`/review`·`/ask` + 输出解析 + rules 注入 + 对话式队列 |
| **M4** 评审 → 发布闭环 | ✅ | findings → 草稿池 → 内联编辑 → 批量发布 + 评论 reply/edit/delete + 合并 |
| **M5** 打磨 + 多平台 | 🔄 | 持续，见 §3 |

> 详细设计：平台适配见 [01](modules/01-platform-adapter.md)、仓库镜像见 [02](modules/02-repo-mirror.md)、
> 状态存储见 [03](modules/03-state-storage.md)、pr-agent 运行时见 [04](modules/04-pragent-runtime.md)、
> 评审闭环见 [05](modules/05-review-workflow.md)、规则见 [06](modules/06-rules.md)、配置见 [07](modules/07-config-and-secrets.md)。

---

## 3. M5 · 打磨与多平台扩展（持续）

开放的持续阶段，不设单一 Done when。

### 已交付 ✅（截至 2026-06-07）

- 嵌入式 pr-agent 运行时打包（内嵌 Python，免装 Python/Docker）
- 首发桌面安装包：Windows x64（NSIS）+ macOS arm64（dmg，ad-hoc 签名）
- 出站 HTTP 代理（LLM / 代码平台 / git HTTPS 统一，loopback 直连）
- `/review` finding anchor 根因修复（get_line_link 注入）
- 多 LLM Provider 适配 + 实测验证（openai / anthropic / deepseek / dashscope / volcengine-ark）
- 真实 token 用量采集（输入 / 输出分列）
- 首启配置向导
- 设置页连接 / LLM / 代理可视化 CRUD
- 单例锁（二次启动聚焦已有窗口）
- 开源发布准备（README + 开发指南 + Apache-2.0 + NOTICE）

### 进行中 / 待办 ⏭️

- **GitHub Adapter（下一步主线）**：先抽 `PlatformAdapter` 一致性测试套件锁定契约，再实现 GitHub
  （公有云 + Enterprise Server）；GitLab 按需。数据层多平台身份字段已预留。
- **高阶 Agent 能力**：复杂任务分步规划 + 长期 Memory。
- **AutoPilot 预评审**：轮询发现新 PR 后按规则自动预跑，进应用即见待确认草稿（决策权仍在评审者）。
- **国际化（i18n）**：多语言界面，优先简体中文 / English。
- **规则市场**：导入 / 导出 rules.dir 片段。
- **可观测性扩展**：规则命中率、模型对比（token 用量已做）。
- **移除 Docker 运行策略**：启动效率低、与「零依赖」定位不符；嵌入式本地进程已是默认（启动开销当前无瓶颈）。
- **大 PR 性能验证**：等真实大样本实测。
- **ollama / openai-compatible 验证**：本地模型 / 自部署链路实测。
- **凭据存储升级 keytar** / **状态存储按需升级 SQLite**（替换抽象实现，业务不变）。
- **CI 自动出包（Win + mac）**：当前手工触发；仅计划 Windows + macOS，暂不出 Linux。

---

## 4. 风险与未决项

| 风险 / 议题 | 应对 |
| --- | --- |
| pr-agent 升级破坏输出格式 | 输出解析层独立 + shim 版本守卫（见 [04](modules/04-pragent-runtime.md)）；CI 跑兼容测试 |
| 大型 PR 性能 / diff 截断 | Diff 走本地 git（不用平台截断端点）+ Monaco 懒加载 + 大文件跳过（见 [02](modules/02-repo-mirror.md)） |
| 大型仓库挤爆磁盘 | `repos_dir` 可配置 + 设置页显示体积 + 清理 |
| 明文凭据（config.yaml） | 文件权限收紧 + 文档警示 + `SecretStore` 抽象预留 keytar（见 [07](modules/07-config-and-secrets.md)） |
| JSON 状态文件膨胀 | 监控单文件大小；触发条件达成切 SQLite（见 [03](modules/03-state-storage.md)） |
| LLM 调用成本 | token 用量统计已做；规则层可控 max_tokens / 模型分级 |

---

## 5. 相关文档

- **[模块设计文档](modules/README.md)** —— 各模块的当前设计与实现（首选入口）
- [开发指南](development/README.md) —— 环境、启动、构建（开发专题入口）
- [打包与发布](development/packaging-release.md) —— 构建 / 签名 / CI
- [macOS 构建与发布](development/mac-build.md) —— ad-hoc 签名路线
