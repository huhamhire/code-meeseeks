# CLI 工具（meebox）

## 职责与边界

提供一个**独立分发的跨平台命令行客户端**，经[本地 API](01-service-api.md) 消费应用能力，供外部
agent / 脚本 / CI 把 meebox 的 PR 发现、浏览与 Agent 操作纳入自动化流程。命令名 **`meebox`**。

> 面向用户的使用说明见 [docs/guide/06-cli.md](../../guide/06-cli.md)。

负责：把 API 端点封装成顺手的命令树、解析连接 / 鉴权配置、按人 / 机两种消费方式输出（文本 / JSON）、
约定退出码。

**不负责**：

- 业务逻辑 —— CLI 是 API 的瘦客户端，不内置任何评审 / 平台逻辑。
- **写操作**（发评论、审批、发布等）—— 不提供对应命令；API 本就不开放（见 [服务端的只读边界](01-service-api.md)）。
- 桌面应用本体 —— CLI **不内嵌进安装包**，是独立可分发物（见下「分发」）。

## 核心设计

### 技术栈与仓库形态决策（Go 评估）

CLI 优先技术栈定为 **Go**，并就「是否内嵌当前项目」给出结论——**该问题分两层，结论不同**：

1. **是否打进 Electron 安装包：否。** CLI 面向外部自动化、经 HTTP 与应用通信，无需随桌面包分发；打进去
   只会无谓增大安装体积。二者是**相互独立的可分发物**。
2. **源码是否放进本仓库（monorepo）：是，但作为独立的顶层 `cli/` 目录、自带 `go.mod`，不纳入 npm
   workspaces / Nx。** Go 有独立的模块系统与构建缓存，与 npm/Nx 的工程模型不兼容；强行包成 Nx project
   （run-commands 壳）徒增复杂、且让 Go 工具链成为全仓开发的前置。CLI 与主工程的**唯一耦合是 HTTP/JSON
   线协议**（语言无关），无代码级共享，故「同仓、独立构建」最自然。

**为什么 Go 适合做这个 CLI**：静态链接小体积二进制、`GOOS`/`GOARCH` 一条命令交叉编译出全平台、启动快、
无运行时依赖——正是分发型 CLI 的理想形态。相较把 Node/TS 用 pkg / SEA 打包（产物数十 MB、交叉编译脆弱、
冷启动慢），Go 在分发体验上明显占优。

**代价与应对——类型契约同步**：Go 端无法编译期复用 `shared` 的 TS 类型。

- **初期**：API 端点少而稳，**手写 Go struct 对齐文档契约**即可（成本低）。
- **将来**：若契约增长，引入 OpenAPI / JSON Schema 作单一事实源，生成 TS 侧校验 + Go 侧 client，
  消除手工漂移。

### 连接与鉴权

CLI 需 API base URL + token。来源优先级（高 → 低）：

1. 命令行 flag：`--api-url` / `--token`；
2. 环境变量：`MEEBOX_API_URL` / `MEEBOX_TOKEN`；
3. CLI 自身配置文件 `~/.code-meeseeks/cli.yaml`（与 GUI 的 `config.yaml` 同目录、独立文件，隔离二者配置）；
4. **本机自动发现**：同机同用户时，读用户主目录下的应用主配置 `~/.code-meeseeks/config.yaml` 的 `service`
   段，自动取 `host`/`port`/`token`——本机集成**零配置**开箱即用。

远端（服务端绑 `0.0.0.0`）场景无法自动发现，须显式给 `--api-url` + `--token`。token 缺失即报鉴权错误。

### 命令结构

```text
meebox [全局 flag] <组> <命令> [参数]

全局 flag：--api-url · --token · --output (yaml|json) · --quiet
```

| 命令 | 用途 | 对应 API |
| --- | --- | --- |
| `meebox categories` | 列当前启用平台下可用的分类标签（一级 + 二级） | `GET /categories` |
| `meebox pr list [--primary <一级>] [--secondary <二级>] [--query <检索>]` | PR 列表（不分页、全部基础信息） | `GET /prs` |
| `meebox pr show <id>` | 描述详情 | `GET /prs/{id}` |
| `meebox pr diff <id> [--file <path>] [--side base\|head]` | 无 `--file` 列变更文件；有则取该文件内容 | `GET /prs/{id}/diff` |
| `meebox pr activity <id>` | 动态（时间线） | `GET /prs/{id}/activity` |
| `meebox pr commits <id>` | 提交列表 | `GET /prs/{id}/commits` |
| `meebox pr reviewers <id>` | 评审人审批状态 | `GET /prs/{id}/reviewers` |
| `meebox agent status <id>` | Agent 当前执行状态 | `GET /prs/{id}/agent` |
| `meebox agent history <id>` | 历史会话 | `GET /prs/{id}/agent/conversation` |
| `meebox agent review <id>` | 执行 auto review | `POST /prs/{id}/agent/review` |
| `meebox agent instruct <id> <command> [args]` | 发送 Agent 指令（仅只读：describe / review / ask / improve） | `POST /prs/{id}/agent/instruct` |
| `meebox agent chat <id> <message>` | 自然语言聊天（可触发任务执行） | `POST /prs/{id}/agent/chat` |

- `<id>` 为 PR 的 `localId`（由 `pr list` 输出获得）。
- 写工具不在 `instruct` 白名单内；传入即被服务端拒绝（CLI 也可前置友好报错）。

### 输出与退出码

- **`--output yaml`（默认）**：把响应渲染为 YAML（类 k8s `-o yaml`）——结构化又可读，便于人交互式查看。
  与 JSON 一样是对响应数据的**通用转换**，不做逐命令表格 / formatter（省去手写 struct 的契约同步负担）。
- **`--output json`**：原样输出 API `data`，供外部 agent / 脚本机器消费。agent 传参无门槛，故默认面向人优化（YAML）、
  机器集成显式取 `json`；两者字段形状同源、皆稳定。
- **退出码约定**：`0` 成功；非 0 表错误并按类别区分（如 `2` 鉴权失败、`3` 资源不存在、`1` 通用错误）；
  错误信息打 `stderr`，携带服务端返回的错误码（`ESV*` 等），便于脚本分支处理。

### 实现选型

- Go + 命令树库（如 cobra）+ 标准 `net/http` client，**最小依赖**。
- 错误码 / 响应封套与服务端契约一一对齐（见 [服务端契约](01-service-api.md)）。

## 数据 / 接口契约

- **配置来源优先级**：flag > env（`MEEBOX_API_URL` / `MEEBOX_TOKEN`）> CLI 配置文件
  （`~/.code-meeseeks/cli.yaml`）> 本机 `~/.code-meeseeks/config.yaml` 自动发现。
- **输出模式**：`yaml`（默认，人，类 k8s `-o yaml`）/ `json`（机，输出 API `data`）；均为响应数据的通用转换。
- **退出码**：`0` 成功 / `1` 通用 / `2` 鉴权 / `3` not found（按需扩展）。
- **二进制与压缩包命名**：`meebox-cli-<version>-<os>-<arch>.<ext>`（unix `.tar.gz`、windows `.zip`），
  附 `.sha256` 校验和。`<version>` 与应用版本对齐（同一 `v*` tag）。

## 分发与 CI

- **覆盖平台**：Windows x64、macOS arm64、Linux x64 / arm64。
- **随主工程一起发布**：在发布流程中增加一个 **Go 构建 job**（`actions/setup-go` + `GOOS`/`GOARCH` 交叉编译
  矩阵；可选 GoReleaser 简化），产出四平台压缩包 + 校验和，与桌面安装包一并上传到**同一个 GitHub Release**
  （由现有 `v*` tag 触发，见 [发布流程](../../../AGENTS.md)）。
- 版本号与应用同源（同 tag），确保 CLI 与服务端 API 契约版本可对应。

## 扩展与注意事项

- **只读边界**：写操作显式不提供；新增命令前先确认对应 API 端点已存在且为只读。
- **加新命令先加端点**：CLI 不得绕过 API 直连应用内部；能力缺口先在[服务端](01-service-api.md)补端点。
- **本机自动发现的边界**：仅同机同用户可读主目录下的 `~/.code-meeseeks/config.yaml`；远端 / 跨用户必须显式配 URL + token。
- **契约漂移防护**：初期手写 struct 务必随服务端契约同步更新；契约增长后转 OpenAPI / Schema 代码生成。
- **JSON 优先稳定**：`--output json` 是自动化主路径，其字段形状视为对外契约，演进需保持兼容。
