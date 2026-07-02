# 服务监听与本地 API

## 职责与边界

在主进程内提供一个**本地 HTTP API**，把应用既有的 PR 发现 / 浏览 / Agent 操作能力，以语言无关的
线协议暴露给**外部 agent / 工具 / 脚本**（经 [CLI](02-cli.md) 或直接 HTTP 调用）。是继渲染层 IPC
之后的**第二个前端**——同一套主进程 service 层，换一层入站协议。

负责：服务监听开关与生命周期、bearer token 鉴权、请求路由与响应封装、把内部能力映射成稳定的 HTTP 契约。

开放的**写操作**限定为评审动作：approve / needswork（远端评审决断）与顶层 comment（发评论），复用
GUI 同源 controller（见下「写边界」）。另有 `POST …/refresh` 触发一次本地轮询刷新——虽用 POST，但
**无远端写副作用**（纯读远端 + 落本地），不属评审写动作范畴，与合并 / 变更类工具的禁令无关。

**不负责**：

- **合并与 pr-agent 变更类工具** —— merge（合并 PR）、pr-agent 的 publish 等变更工具不开放；有此需求由
  调用方自行用平台 API 实现（见下「写边界」）。
- **多用户 / 远端服务形态** —— 仍是单用户本地应用，API 只是本机（或可选局域网）的入站通道，不引入账户体系。
- 业务逻辑本身 —— 复用 IPC controller 同源的 service 层，不在 HTTP 侧另起一套实现。

## 核心设计

### 默认关闭、强制鉴权

- **默认不启用**：`config.yaml` 新增 `service` 段，`enabled` 默认 `false`。不开启则主进程不监听任何端口，
  对外零暴露面。
- **强制 bearer token**：开启监听即要求 token——所有请求须带 `Authorization: Bearer <token>`，缺失 / 不匹配
  直接拒绝（401 + 错误码）。**没有「关闭鉴权」选项**。开关首次打开时若 token 为空则**自动生成**一枚高强度
  随机 token（`crypto.randomBytes` → base64url / hex），保证「启用」与「有 token」原子绑定。
- **比对用常数时间**：token 校验走常数时间比较，避免计时侧信道。
- **token 落盘策略同既有凭据**：token 明文存 `config.yaml`（与平台 token / LLM key / 代理密码一致，经
  `SecretStore` 抽象读写、绝不进日志 / 异常栈），属已知风险、文件权限收紧。将来切 keychain 时随既有凭据一并迁移。

### 监听地址与端口

- **默认仅 loopback**：`host` 默认 `127.0.0.1`，只本机可达。这是绝大多数「本机外部 agent 集成」场景的安全默认。
- **可选 `0.0.0.0`**：允许配置为监听所有网卡（供同网段的远端 agent / CI 节点接入）。这是**显式高风险选项**——
  设置页与文档须给安全警示（token 即唯一防线、建议配合防火墙 / 反代）。绑 `0.0.0.0` 时 token 强度与保密尤为关键。
- **固定安全默认端口**：默认 `18765`（可在配置中改）。取 10000+ 既避开拥挤的 8xxx 开发 / 系统服务段
  （3000 / 5173 / 8000 / 8080 / 8888 等），又稳落在**临时端口范围（ephemeral，Windows 49152+ / Linux 32768+）
  之下**——固定监听端口若落进临时段可能与系统瞬时出站 socket 抢占，`18765` 处于已注册端口段、无此风险。
  端口被占用导致监听失败时，记录错误并以非致命方式提示（不阻塞应用启动）。

### HTTP 实现：最小依赖

- 用 Node 内置 `http` 起服务 + **极简手写路由**（按 method + path 模式匹配），**不引入 express 等重型框架**——
  与项目「优先复用、最小依赖」一致，端点数量有限、无需框架。
- 统一中间环节：JSON body 解析（带最大 body 上限）、请求超时、鉴权校验、错误 → 响应封装、访问日志
  （记 method / path / status / 耗时，**不记** token 与敏感 body）。

### 路由复用 service 层

- HTTP route handler 经与 IPC controller **同一个进程级 `ControllerContext`**（`getContext()`）取用 service
  （`ctx.pr` / `ctx.orchestrator` / `ctx.poller` / `ctx.connectionRuntime` 等），**不重复业务逻辑**。
- 原则：核心能力沉在 service 层，IPC 与 HTTP 各自只做**薄封装 + 协议适配**。新增 API 端点前，先确保对应能力
  在 service 层有可复用方法（必要时把 controller 内联逻辑下沉到 service）。

### 写边界（放开评审动作，拒绝合并与变更类 Agent 工具）

- 开放的写操作**限定评审动作**：`POST …/approve`·`…/needswork`（远端评审决断，复用 `prs:setLocalStatus`——
  先写远端评审状态、再落本地）与 `POST …/comment`（发顶层评论，复用 `comments:create`）。均为真实远端写。
- Agent 指令（`…/agent/instruct`）**仍限只读工具**（`/describe`·`/review`·`/ask`·`/improve`）；变更类工具
  （`/publish` 等，见工具注册表 `kind: 'mutating'`）**在 API 层即被硬拒绝**——与 Agent 自身 grant 授权闸
  **相互独立**：即便某 PR 的 AutoPilot grants 授予了写权限，经 API 的 instruct 仍不得触发写工具。评审写动作
  改走上面的 approve / needswork / comment 专用端点，不经 instruct。
- **不开放合并（merge）**：对远端影响大且不可逆，暂不纳入 API。
- **无二次确认**：API 无交互确认通道；已开放的写端点直接执行（调用方自负授权），需交互确认的动作（如合并）
  干脆不开放。

### 生命周期与热生效

- **启动时机**：在主进程完成连接 / IPC 初始化（`ControllerContext` 就绪）之后、轮询启动前后启动监听器；
  仅当 `service.enabled` 为真才实际 `listen`。
- **优雅关闭**：应用退出（`before-quit`）时关闭监听、停止接收新连接、放行 in-flight 请求后退出。
- **热生效**：`enabled` / `host` / `port` / token 变更 → 写盘 + 内存同步 + **停旧监听起新监听**（端口 / 地址变更
  必然重建；token 变更即时生效，旧 token 立刻失效）。与既有「保存即热生效」一致，无需重启应用。

### 并发与资源

- 只读 `GET` 端点可并发处理。
- Agent 写入型动作（触发 review / 指令 / 聊天）**复用既有 run 队列与 Orchestrator 的单工作者 + 并发上限**，
  不绕过调度——API 触发与 GUI 触发在同一队列里排队，互不抢占语义保持一致。

## 数据 / 接口契约

### 配置（`config.yaml` 顶层 `service`）

```yaml
service:
  enabled: false        # 总开关；默认关 = 不监听、零暴露面
  host: 127.0.0.1        # 监听地址；可设 0.0.0.0（高风险，需安全警示）
  port: 18765            # 固定安全默认端口（10000+，避开 8xxx 拥挤段且低于临时端口范围），可改
  token: ''              # bearer token；启用且为空时自动生成；明文落盘（同既有凭据策略）
```

### 鉴权

- 请求头：`Authorization: Bearer <token>`；缺失 / 不匹配 → `401` + 错误码。
- token 经 `SecretStore` 读写，响应 / 日志中不回显。

### 统一响应封套

```jsonc
// 成功
{ "ok": true, "data": <T> }
// 失败（复用 AppError 的 code + 可序列化 meta；前端 / CLI 按码本地化）
{ "ok": false, "error": { "code": "ESV0001", "meta": { /* ... */ } } }
```

- HTTP 状态码与语义对齐：`400` 校验失败 / `401` 未授权 / `403` 写工具被拒（未开放的写操作）/ `404` 资源不存在 /
  `409` 冲突 / `500` 内部错误。
- 新增 **`SV`（service）错误码领域**（`E`+`SV`+四位，见 [错误码规范](../99-core/04-error-codes.md)）：
  如 token 无效、写操作被拒、监听未就绪等；与既有 `AG`/`PR`/`NT` 等领域并列。

### 端点（`/api/v1`，逐条对应 [CLI](02-cli.md) 命令）

读端点用 `GET`、写端点用 `POST`。列表返回**精简投影**，其余读端点返回同源结构。

| Method & Path | 用途 | 复用的内部能力 |
| --- | --- | --- |
| `GET /api/v1/whoami` | 当前身份：活动连接 PAT 所属用户（`name`/`displayName`/`slug`）+ 集成平台 + 连接显示名；无活动连接各项 null | 连接摘要（当前用户 + 平台） |
| `GET /api/v1/categories` | 当前启用平台下可用的分类标签：`categories`（`PrDiscoveryFilter`）+ `statuses`（状态 / 合并态筛选），按平台能力裁剪 | 平台能力位 + 列表筛选语义 |
| `POST /api/v1/refresh` | 触发一次立即轮询刷新（拉取所有连接的最新 PR、落本地），返回本轮计数汇总（`PollResult`：fetched / changed / added / removed / errors）；等价 GUI 手动刷新，无远端写副作用 | `poller.tick`（`prs:refresh` 同源） |
| `GET /api/v1/version` | 服务端（桌面应用）版本（`{ version }`），供 CLI `version` 命令同时展示客户端 + 服务端版本 | `buildAppInfo().appVersion`（`app:info` 同源） |
| `GET /api/v1/prs` | PR 列表（**精简投影** `PrListItem`：字段序 id/title/author/createdAt 优先，去 description、人员仅 slug）；query：`category`（一级）/`status`（二级）/`q`（检索）/`skip`+`limit`（分页，默认 limit 100） | `prs:list` + 列表筛选谓词 + 视图投影 |
| `GET /api/v1/prs/{id}` | 描述详情（完整 `StoredPullRequest`：标题 / 描述 / 作者 / 分支 / 时间 / 状态 / 合并态） | `StoredPullRequest` |
| `GET /api/v1/prs/{id}/diff` | 变更文件列表；带 `?path=&side=base\|head` 时取单文件内容 | `diff:listChangedFiles` / `diff:getFileContent` 同源 |
| `GET /api/v1/prs/{id}/activity` | 动态（评论 / 提交更新 / 评审决断归并的时间线） | `diff:listActivity` 同源 |
| `GET /api/v1/prs/{id}/commits` | 提交列表（`PrCommit[]`） | `diff:listCommits` 同源 |
| `GET /api/v1/prs/{id}/reviewers` | 评审人审批状态（`Reviewer[]`，含各人 `status`） | `StoredPullRequest.reviewers` |
| `GET /api/v1/prs/{id}/agent` | Agent 当前执行状态（`AgentSession`：status / 进度 / 总结 / 建议） | `agent:getSession` 同源 |
| `GET /api/v1/prs/{id}/agent/conversation` | 历史会话（`AgentMessage[]`） | `agent:getConversation` 同源 |
| `POST /api/v1/prs/{id}/agent/review` | 执行 auto review（固定评审微流程 describe→review→[追问]→总结） | `agent:run` 同源 |
| `POST /api/v1/prs/{id}/agent/instruct` | 发送 Agent 指令（**仅只读工具**：describe / review / ask / improve；写工具硬拒绝） | 只读工具派发（复用 run 队列） |
| `POST /api/v1/prs/{id}/agent/chat` | 发送自然语言聊天（可触发 Agent 规划与任务执行） | `agent:ask` / `agent:enqueueMessage` 同源 |
| `POST /api/v1/prs/{id}/agent/stop` | 中断该 PR 运行中的 Agent（思考 / 执行任意阶段即时停；PR 级，非按单个 run） | `agent:stop` 同源 |
| `POST /api/v1/prs/{id}/approve` | 评审决断「通过」（写远端评审状态 + 落本地） | `prs:setLocalStatus` 同源 |
| `POST /api/v1/prs/{id}/needswork` | 评审决断「需修改」（写远端评审状态 + 落本地） | `prs:setLocalStatus` 同源 |
| `POST /api/v1/prs/{id}/comment` | 发一条顶层评论（body 为正文，空则 400） | `comments:create` 同源 |

- `{id}` 即 PR 的 `localId`——跨平台稳定 PR 标识（内部哈希，非平台 `remoteId`）；列表投影里对外命名为 `id`，所有 PR 维度端点以它定位。
- 过程步骤（transcript）暂不在初版 API 内开放，作为将来扩展位（见下）。

### 新增 IPC（设置页驱动）

- `config:setService`：写 `service` 段 → 写盘 + 内存同步 + 重建监听器（热生效）。
- `config:generateServiceToken`：重新生成 token → 写盘 + 即时失效旧 token，返回新 token 供 UI 展示 / 复制。

## 扩展与注意事项

- **加新端点先下沉 service**：HTTP 与 IPC 必须共用 service 方法，避免逻辑分叉；端点是 service 能力的薄投影。
- **写边界是硬约束**：评审写动作仅经 approve / needswork / comment 专用端点；Agent `instruct` 的只读工具
  白名单在 API 层强校验、独立于 Agent grant 闸——新增 Agent 工具时同步确认其 `kind` 与是否纳入 instruct
  白名单，默认排除一切 `mutating`。放开新的写端点须显式评估远端副作用（合并等高影响动作暂不开放）。
- **`0.0.0.0` 安全警示不可省**：设置页与使用文档须明确暴露范围与风险；token 是唯一防线。
- **端口冲突**：监听失败以非致命方式提示，不拖垮应用启动；提示用户改端口。
- **进度推送是将来扩展位**：初版以「轮询 `GET .../agent` 拉状态」为主；如需实时进度，可在同一监听器上加
  SSE / WebSocket 推送 Agent step 事件（复用现有 `agent:stepProgress` 广播），不改既有 REST 契约。
- **契约稳定性**：`/api/v1` 前缀预留版本演进位；响应封套与错误码领域一旦发布需保持兼容（CLI 与第三方依赖它）。
