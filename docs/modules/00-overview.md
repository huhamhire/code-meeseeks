# 00 · 架构总览

## 职责与边界

本篇给出整体架构与各模块的关系，作为其余模块文档的入口。具体设计落在各分篇。

形态：单用户**本地桌面应用**（Electron），无服务端、无多用户同步。主进程（Node）承载所有
业务与 IO；渲染层（React）只做展示与交互，经 IPC 调主进程。

## 核心设计

### 进程模型

- **Main（Node + TS）**：业务与 IO 的唯一所在——轮询、仓库镜像、跑 pr-agent、状态读写、发布评论。
  单写者，独占状态目录，无需文件锁。
- **Renderer（React）**：UI（PR 列表 / Diff / 对话 / 草稿）。`contextIsolation` 开、无 `nodeIntegration`、走 CSP。
- **Preload**：经 `contextBridge` 只暴露一个泛型 `invoke(channel, req)` 与少量事件订阅，不暴露 Node 能力。

### IPC

Renderer ↔ Main 全部走 `ipcMain.handle(channel, …)` + 渲染侧泛型 `invoke<K>(channel, req)`，由一份
集中的 `IpcChannels` 类型映射约束请求/响应类型。新增交互＝先在该映射加通道类型，再两侧实现。
（注意：早期设想用 tRPC，实际是这套手写类型映射。）

### 数据流（一次评审的主链路）

```
轮询(Poller) ──按连接拉「我作为 reviewer 待处理的 PR」──▶ 状态存储(per-PR 目录)
                                                            │
用户选中 PR ──▶ 仓库镜像(RepoMirror) 同步 bare + 物化 worktree
                                                            │
对话框 /review ──▶ pr-agent 桥(PrAgentBridge) 在 worktree 上跑嵌入式 pr-agent
                                            │
                         输出解析为 findings ──▶ 草稿池 ──▶ 用户确认/编辑 ──▶ 批量发布(平台 Adapter)
```

### 模块地图（packages / 主进程子系统）

| 领域 | 承载 | 分篇 |
| --- | --- | --- |
| 代码平台适配 | `platform-bitbucket-server` + `PlatformAdapter` 抽象 | [01](01-platform-adapter.md) |
| 仓库镜像与 Diff | `repo-mirror` | [02](02-repo-mirror.md) |
| 状态存储与数据模型 | `state-store` + `poller` 的 pr-state | [03](03-state-storage.md) |
| pr-agent 集成与运行时 | `pr-agent-bridge` + 嵌入式运行时 | [04](04-pragent-runtime.md) |
| 评审→发布闭环 | `poller`(输出解析) + 主进程草稿/发布 | [05](05-review-workflow.md) |
| 规则系统 | `rules` | [06](06-rules.md) |
| 配置与凭据 | `config` + 设置页 | [07](07-config-and-secrets.md) |
| 出站网络与代理 | 主进程 proxy plumbing | [08](08-networking-proxy.md) |
| 打包与发布 | electron-builder + 嵌入式运行时打包 | [09](09-packaging-release.md) |

`shared` 是跨包共享类型（含 `IpcChannels` 契约、PR/Finding/Run 等领域类型）；`logger` 是统一日志。

### 工程基线

- npm workspaces + Nx 单仓多包；统一 `lint`/`typecheck`/`test`/`build` 任务（详见根 `AGENTS.md`）。
- 桌面壳 Electron + electron-vite；渲染 React + Monaco（并排/内联 diff）。

## 数据 / 接口契约

- **IPC 契约**：集中在 `shared` 的 `IpcChannels` 类型映射（`channel → { request, response }`）。
- **领域类型**：PR（`StoredPullRequest` / `PrIdentity`）、评论（`PrComment`）、评审 run（`ReviewRun`，含
  `findings` / `tokenUsage`）、平台抽象（`PlatformAdapter`）均在 `shared`，被各包共享。

## 扩展与注意事项

- **加新代码平台**：实现 `PlatformAdapter`，业务层（Poller/发布/镜像）不感知具体平台。见 [01](01-platform-adapter.md)。
- **跨进程能力**一律走 IPC 通道 + 类型映射，别在渲染层直接碰 Node / 文件 / 网络。
- 各分篇描述「当前实现」，演进时同步更新对应分篇即可。
