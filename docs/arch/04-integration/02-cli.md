# CLI 工具（meebox）

## 职责与边界

提供一个**独立分发的跨平台命令行客户端**，经[本地 API](01-service-api.md) 消费应用能力，供外部
agent / 脚本 / CI 把 meebox 的 PR 发现、浏览与 Agent 操作纳入自动化流程。命令名 **`meebox`**。

负责：把 API 端点封装成顺手的命令树、解析连接 / 鉴权配置、按人 / 机两种消费方式输出（文本 / JSON）、
约定退出码。提供浏览与**评审写动作**（approve / needswork / comment）——与服务端写边界一致。

**不负责**：

- 业务逻辑 —— CLI 是 API 的瘦客户端，不内置任何评审 / 平台逻辑。
- **合并与变更类 Agent 工具**（merge / publish 等）—— 不提供对应命令；API 本就不开放（见 [服务端写边界](01-service-api.md)）。
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
3. CLI 自身配置文件 `~/.code-meeseeks/cli.yaml`（与 GUI 的 `config.yaml` 同目录、独立文件，隔离二者配置）。

连接信息须**显式提供**（flag / 环境变量 / `cli.yaml` 三者之一），token 缺失即报鉴权错误。`meebox login
--token <token> [--server <url>]` 把 token（与可选 server，默认 loopback）写入 `cli.yaml`，免去后续每次传参——
它是 CLI 唯一的配置**写入**命令，与 `cli.yaml` 的读取（上述优先级）配对，使配置管理自洽。

**不读取 GUI 主配置**：CLI 刻意**不**读应用主配置 `~/.code-meeseeks/config.yaml`。该文件承载连接层机密
（各代码平台的访问令牌等），若从中静默取服务令牌，等于让 CLI 触达其本不应接触的凭据——属预期外的越权访问，
故移除此前的「本机自动发现」设计。环境变量 `MEEBOX_TOKEN` 是本机免逐次传参的推荐方式（配合 shell / CI 环境注入）。

### 命令结构

```text
meebox [全局 flag] <组> <命令> [参数]

全局 flag：--api-url · --token · --output (yaml|json) · --quiet
```

命令分两类——**根层级系统性命令** 与 **两个领域组**：

- **系统性命令（根层级）** —— `login`（保存凭据到 `cli.yaml`）、`whoami`（身份）、`version`（客户端 +
  服务端版本）、`skill`（打印内嵌的 SKILL.md）：与具体 PR / Agent 无关的工具 / 会话层操作，直接置于根层级、
  不套领域组（符合 `kubectl version` / `gh auth` 等惯例）。
- **`pr`** —— PR 相关操作：浏览 + 评审写动作，并含 `categories`（`pr list` 的筛选词表）与 `refresh`
  （触发一次拉取、刷新 PR 列表）。
- **`agent`** —— 评审 Agent 操作。

`pr` / `agent` 下的 PR 维度子命令用**必填 flag `--pr <id>`** 传 PR 标识（`id` 由 `pr list` 输出获得）——
agent **不嵌进 `pr`**（避免 `pr agent … --pr` 里 `pr` 重复），与 `pr` 平级；根层级系统性命令与
`pr categories` / `pr refresh` / `pr list` 非 PR 维度，无需 `--pr`。

| 命令 | 用途 | 对应 API |
| --- | --- | --- |
| `meebox login --token <token> [--server <url>]` | 保存 token（与可选 server，默认 loopback）到 `cli.yaml`，供后续命令免传参 | —（本地写，无 API） |
| `meebox whoami` | 当前身份（用户 + 平台 + 连接名） | `GET /whoami` |
| `meebox version` | 客户端（CLI）+ 服务端（应用）版本；服务端不可达时仅客户端、退出码仍 0 | `GET /version` |
| `meebox skill` | 打印构建时 `go:embed` 内嵌的 agent 使用说明（SKILL.md） | —（本地，无 API） |
| `meebox pr categories` | 列当前启用平台的分类标签（`categories` 一级 + `statuses` 二级）——`pr list` 的筛选词表 | `GET /categories` |
| `meebox pr refresh` | 触发一次立即轮询刷新（拉取最新 PR、落本地），返回本轮计数汇总（fetched / changed / added / removed / errors）；等价 GUI 手动刷新 | `POST /refresh` |
| `meebox pr list [--category <一级>] [--status <二级>] [--query <检索>] [--skip N] [--limit N]` | PR 列表（精简投影 + 分页，默认 limit 100） | `GET /prs` |
| `meebox pr show --pr <id>` | 描述详情 | `GET /prs/{id}` |
| `meebox pr diff --pr <id> [--file <path>] [--side base\|head]` | 无 `--file` 列变更文件；有则取该文件内容 | `GET /prs/{id}/diff` |
| `meebox pr activity --pr <id>` | 动态（时间线） | `GET /prs/{id}/activity` |
| `meebox pr commits --pr <id>` | 提交列表 | `GET /prs/{id}/commits` |
| `meebox pr reviewers --pr <id>` | 评审人审批状态 | `GET /prs/{id}/reviewers` |
| `meebox pr approve --pr <id>` | 评审决断「通过」（真实远端写） | `POST /prs/{id}/approve` |
| `meebox pr needswork --pr <id>` | 评审决断「需修改」（真实远端写） | `POST /prs/{id}/needswork` |
| `meebox pr comment --pr <id> <message>` | 发一条顶层评论（真实远端写） | `POST /prs/{id}/comment` |
| `meebox agent status --pr <id>` | Agent 当前执行状态 | `GET /prs/{id}/agent` |
| `meebox agent history --pr <id>` | 历史会话 | `GET /prs/{id}/agent/conversation` |
| `meebox agent review --pr <id>` | 执行 auto review | `POST /prs/{id}/agent/review` |
| `meebox agent instruct --pr <id> <command> [args]` | 发送 Agent 指令（仅只读：describe / review / ask / improve） | `POST /prs/{id}/agent/instruct` |
| `meebox agent chat --pr <id> <message>` | 自然语言聊天（可触发任务执行） | `POST /prs/{id}/agent/chat` |
| `meebox agent stop --pr <id>` | 中断该 PR 运行中的 Agent（PR 级） | `POST /prs/{id}/agent/stop` |
| `meebox agent run list --pr <id>` | 该 PR 运行队列中的 pr-agent runs（active + waiting） | `GET /prs/{id}/agent/runs` |
| `meebox agent run cancel --pr <id> --run <runId>` | 按 run 取消一个 pr-agent 工具调用 | `POST /prs/{id}/agent/runs/{runId}/cancel` |

- `<id>` 为 PR 的 `localId`（列表投影里对外命名为 `id`，由 `pr list` 输出获得）。
- 评审写动作走 `pr approve` / `pr needswork` / `pr comment` 专用命令；变更类工具（publish 等）不在 `instruct`
  白名单内，传入即被服务端拒绝（CLI 亦前置友好报错）。merge（合并）不提供。
- 中断粒度：`agent stop` 停整个 PR 的 Agent；`agent run cancel` 只取消指定的单个 pr-agent run。

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
  （`~/.code-meeseeks/cli.yaml`）。连接信息须显式提供；CLI 不读 GUI 主配置 `config.yaml`（含连接层机密）。
- **输出模式**：`yaml`（默认，人，类 k8s `-o yaml`）/ `json`（机，输出 API `data`）；均为响应数据的通用转换。
- **退出码**：`0` 成功 / `1` 通用 / `2` 鉴权 / `3` not found（按需扩展）。
- **二进制与压缩包命名**：`meebox-cli-<version>-<os>-<arch>.<ext>`（Windows / macOS 用 `.zip`、Linux 用 `.tar.gz`），
  附 `.sha256` 校验和。`<version>` 与应用版本对齐（同一 `v*` tag）。
- **压缩包内容 = 可直接投放的 skill 目录**：除二进制外一并打包 `LICENSE` + `README.md` + `SKILL.md`。解压到
  agent 的 skills 目录即得一个可用 skill——`SKILL.md`（frontmatter `name: meebox`）教 agent 用法，紧邻其驱动
  的二进制。这是 CLI「面向 agent 交付」的主形态。
- **二进制自述（`go:embed`）**：同一份 `SKILL.md` 经 `go:embed` 于构建期内嵌进二进制，`meebox skill` 打印之。
  即便二进制脱离压缩包（如 `go install` 或裸放 `PATH`）也能自述用法，且内嵌内容与随包 `SKILL.md` 构建期一致。
  刻意**不做** `--manifest` 之类的 function-calling JSON——skill 的消费形态是 markdown，非工具 schema 注入；
  真有此需求应从命令树生成、而非另手维护一份 JSON。

## 分发与 CI

- **覆盖平台**：Windows x64、macOS arm64、Linux x64 / arm64。
- **随主工程一起发布**：发布流程的 **Go 构建 job**（`actions/setup-go` + `GOOS`/`GOARCH` 交叉编译矩阵）产出
  四平台压缩包（含二进制 + `LICENSE` + `README.md` + `SKILL.md`）+ 校验和，与桌面安装包一并上传到**同一个
  GitHub Release**（由现有 `v*` tag 触发，见 [发布流程](../../../AGENTS.md)）。
- 版本号与应用同源（同 tag），确保 CLI 与服务端 API 契约版本可对应。
- **一键安装脚本（macOS / Linux）**：`tools/cli/install.sh` 经 `curl … | bash` 一条命令完成安装——探测系统 /
  架构 → 取匹配的 Release 压缩包 → 校验 SHA-256 → 解出 `meebox` 装入 `PATH`（默认 `/usr/local/bin`，不可写回退
  `~/.local/bin`；`MEEBOX_VERSION` / `MEEBOX_BIN_DIR` 可覆盖）。刻意**不落地 `SKILL.md`**（已内嵌、`meebox skill`
  可导出）。Windows 不在脚本覆盖内，走手动下载。

## 扩展与注意事项

- **写边界与服务端一致**：仅提供评审写动作（approve / needswork / comment）；合并与变更类 Agent 工具不提供。
  新增命令前先确认对应 API 端点已存在，写端点须与服务端写边界对齐。
- **加新命令先加端点**：CLI 不得绕过 API 直连应用内部；能力缺口先在[服务端](01-service-api.md)补端点。
- **不触碰 GUI 机密**：CLI 不读应用主配置 `~/.code-meeseeks/config.yaml`（含各平台访问令牌等连接层机密）；服务令牌须经 flag / 环境变量 / `cli.yaml` 显式提供，避免越权触达预期外凭据。
- **契约漂移防护**：初期手写 struct 务必随服务端契约同步更新；契约增长后转 OpenAPI / Schema 代码生成。
- **JSON 优先稳定**：`--output json` 是自动化主路径，其字段形状视为对外契约，演进需保持兼容。
- **代理走环境变量**：HTTP client 用 Go `net/http` 默认 transport，天然遵循标准 `HTTP(S)_PROXY` /
  `NO_PROXY`；loopback（`127.0.0.1` / `localhost`）默认直连不走代理——无需自实现代理逻辑。
