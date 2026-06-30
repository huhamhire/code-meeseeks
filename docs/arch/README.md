# 架构设计文档（Architecture）

按**模块领域**沉淀**当前的设计与实现结论**——「现在是怎样、为什么这样、怎么扩展」。
理解和维护某个模块时，这里是**首选入口**。

## 与其它文档的关系

- **本目录（arch/）= 当前结论**：随实现演进持续更新，是某模块的「事实来源」。
- **ROADMAP = 高层视角**：项目定位、已交付能力、风险与下一步；不放实现细节（细节在这里）。

## 每篇骨架约定

为便于检索与维护，每篇统一结构：

1. **职责与边界** —— 这个模块负责什么、不负责什么。
2. **核心设计** —— 当前采用的设计 + 关键取舍（为什么这样，而非别的）。
3. **数据 / 接口契约** —— 对外类型、IPC 通道、文件格式等稳定契约（用名称与形状描述）。
4. **扩展与注意事项** —— 如何扩展、维护时需注意的要点。

> 原则：**描述设计，不引用代码文件**。文档是耐久的设计说明，不绑定具体文件路径
> （路径会过时，也会让文档沦为文件索引）。需要时点到概念名 / 类型名 / 函数名即可，
> 由读者凭名字在代码里检索。
>
> 数据结构描述走**分级折中**：内部领域类型给「名 + 用途 + 关键字段」（完整字段交类型名去 grep），
> 序列化 / IPC / 磁盘文件等稳定契约给紧凑 shape 块；抽象接口列方法名 + 语义、不写伪签名。

## 模块清单

按专题分目录、目录与文档均带两位序号前缀（平台优先：平台集成 → Agent → GUI → 基础设施）：

```text
docs/arch/
├── 00-overview.md                  架构总览：进程模型 / IPC / 数据流 / 模块关系
├── 01-platform/                    平台集成与 PR 操作
│   ├── 01-adapter.md                 代码平台适配（PlatformAdapter / 能力位与降级 / 多平台差异化 / clone 协议）
│   ├── 02-repo-mirror.md             仓库镜像与 Diff（bare clone / worktree / blame）
│   ├── 03-review-workflow.md         评审→发布闭环（命令 / findings 解析 / 草稿池 / 发布 / merge）
│   └── 04-comment-interactions.md    评论互动（emoji 反应 / @提及补全 / 图片附件；能力位降级 / 三平台差异）
├── 02-agent/                       Agent 与规则
│   ├── 01-agent.md                   Agent 与上下文（目录分层 / 上下文注入 / 工具红线 / 会话隔离 / 模版）
│   ├── 02-session.md                 会话 Agent 化（输入路由 / 规划循环 / 过程留存 / 交互控制）
│   ├── 03-autopilot.md               AutoPilot 与调度（自动预评审 / 准入闸 / 批量判定 / 微流程 / 优先级队列）
│   ├── 04-rules.md                   规则系统（frontmatter / 匹配优先级；正文存 `<agent.dir>/rules/`）
│   └── 05-pragent-runtime.md         pr-agent 集成与运行时（bridge / 嵌入式 Python / sitecustomize / token usage）
├── 03-gui/                         GUI 与交互
│   ├── 01-ui-interaction.md          渲染层布局 / 面板 / 跨 PR 保活 / 交互约定
│   ├── 02-command-palette.md         命令面板（标题栏入口 / 两级选择 / 按语言搜索 / 注册表 + 分域）
│   ├── 03-notifications.md           消息通知（poll 事件投影 / 系统通知 toast / macOS dock 角标 / OS 权限降级）
│   └── 04-i18n.md                    国际化（react-i18next / 双运行时 / key 命名 / 翻译规范 / 模板翻译）
└── 99-core/                        基础设施 / 横切
    ├── 01-state-storage.md           状态存储与数据模型（StateStore / per-PR 目录 / 存储模型 + 业务生命周期）
    ├── 02-config-and-secrets.md      配置与凭据（config.yaml / SecretStore / 设置页 / 首启向导）
    ├── 03-networking-proxy.md        出站网络与代理（HTTP 代理统一 / loopback 直连 / SSH）
    └── 04-error-codes.md             错误码与错误传递（AppError + meta / 跨 IPC 编码 / 前端按码 i18n / 注册表）
```

> 打包 / 构建 / 签名 / CI 不属于产品子系统，已移到开发专题：[`../development/packaging-release.md`](../development/packaging-release.md)。

## 编号规则

- **两级编号**：专题目录两位前缀（`01-platform` / `02-agent` / `03-gui` / `99-core`），目录内文档再两位前缀、从 `01` 起；`00-overview.md` 与本 README 留在根。
- 编号只为排序与稳定引用，不代表强依赖；新增文档取所属目录的下一个空号。
- **`99-core` 取末位 `99`**：基础设施 / 横切专题恒置末尾，新增功能专题依次取 `04`、`05`… 插在它之前，无需为其腾挪编号。
