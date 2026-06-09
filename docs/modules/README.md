# 模块设计文档（Modules）

按**模块领域**沉淀**当前的设计与实现结论**——「现在是怎样、为什么这样、怎么扩展」。
理解和维护某个模块时，这里是**首选入口**。

## 与其它文档的关系

- **本目录（modules/）= 当前结论**：随实现演进持续更新，是某模块的「事实来源」。
- **ROADMAP = 高层视角**：项目定位、里程碑进度、风险与下一步；不放实现细节（细节在这里）。
- **ADR（已废弃）**：早期的设计思考曾以过程性方式留在 `docs/adr/`，与最终实现也多有出入。其结论
  已按领域沉淀进本目录、`docs/adr/` 已移除。决策的「取舍」若有长期价值，直接写进各篇的「核心设计」。

## 每篇骨架约定

为便于检索与维护，每篇统一结构：

1. **职责与边界** —— 这个模块负责什么、不负责什么。
2. **核心设计** —— 当前采用的设计 + 关键取舍（为什么这样，而非别的）。
3. **数据 / 接口契约** —— 对外类型、IPC 通道、文件格式等稳定契约（用名称与形状描述）。
4. **扩展与注意事项** —— 如何扩展、维护时需注意的要点。

> 原则：**描述设计，不引用代码文件**。文档是耐久的设计说明，不绑定具体文件路径
> （路径会过时，也会让文档沦为文件索引）。需要时点到概念名 / 类型名 / 函数名即可，
> 由读者凭名字在代码里检索。

## 模块清单

| 编号 | 模块 |
| --- | --- |
| [`00-overview`](00-overview.md) | 架构总览：进程模型 / IPC / 数据流 / 模块关系 |
| [`01-platform-adapter`](01-platform-adapter.md) | 代码平台适配（PlatformAdapter / 能力位与降级 / Bitbucket / GitHub 差异化适配 / clone 协议） |
| [`02-repo-mirror`](02-repo-mirror.md) | 仓库镜像与 Diff（bare clone / worktree / blame） |
| [`03-state-storage`](03-state-storage.md) | 状态存储与数据模型（StateStore / per-PR 目录 / schema） |
| [`04-pragent-runtime`](04-pragent-runtime.md) | pr-agent 集成与运行时（bridge / 嵌入式 Python / sitecustomize / token usage） |
| [`05-review-workflow`](05-review-workflow.md) | 评审→发布闭环（命令 / findings 解析 / 草稿池 / 发布 / merge） |
| [`06-rules`](06-rules.md) | 规则系统（rules.dir / frontmatter / 匹配优先级） |
| [`07-config-and-secrets`](07-config-and-secrets.md) | 配置与凭据（config.yaml / SecretStore / 设置页 / 首启向导） |
| [`08-networking-proxy`](08-networking-proxy.md) | 出站网络与代理（HTTP 代理统一 / loopback 直连 / SSH） |
| [`09-ui-interaction`](09-ui-interaction.md) | GUI 与交互（渲染层布局 / 面板 / 跨 PR 保活 / 交互约定） |

> 打包 / 构建 / 签名 / CI 不属于产品子系统，已移到开发专题：[`../development/packaging-release.md`](../development/packaging-release.md)。

## 编号规则

- 两位数字前缀，按「从底层基建到上层功能」的大致顺序排列；`00` 为总览。
- 编号只为排序与稳定引用，不代表强依赖；新增领域取下一个空号。
