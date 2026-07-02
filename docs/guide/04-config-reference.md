# 配置文件参考

所有配置集中在唯一的配置文件 **`~/.code-meeseeks/config.yaml`**（YAML 格式）。日常使用通过应用内 **设置** 页与首启向导可视化编辑即可，无需手动改文件；本篇是完整的结构与字段参考，供批量配置、高级参数调整、问题排查时查阅。

- **编辑方式**：设置页保存即写盘并热更新；设置页「用系统关联程序打开 config.yaml」可直接编辑文件。
- **生效时机**：连接 / LLM / 代理 / 语言 / 并发数等改动保存后即时重建生效；个别高级参数（如 `workspace.repos_dir`）需重启应用。
- **凭据说明**：访问令牌、API Key、代理密码以**明文**保存在本文件中（与配置结构隔离但不加密）。请按最小权限申请凭据、妥善保护本文件，泄露后及时吊销。

## 完整示例

```yaml
language: ''            # 空 = 按系统语言自动、回落英语；或显式 zh-CN / en-US / ja-JP / de-DE

appearance:
  editor_theme: auto
  editor_font_family: ''
  editor_font_size: 14

workspace:
  repos_dir: ~/.code-meeseeks/repos

agent:
  dir: ''
  max_steps: 8
  summary_max_chars: 800
  autopilot:
    enabled: false
    batch_size: 10
    grants: []
  strategy:
    auto_followup: true
    max_followup_asks: 2
    max_code_suggestions: 4

poller:
  interval_seconds: 300

proxy:
  enabled: false
  protocol: http
  host: ''
  port: 8080
  username: ''
  password: ''

pr_agent:
  strategy: auto
  max_concurrency: 2

notifications:
  enabled: true
  new_pr: true
  reply: true
  mention: true
  authored_comment: true
  authored_needs_work: true
  authored_conflict: true

service:
  enabled: false
  host: 127.0.0.1
  port: 18765
  token: ''

update:
  check_enabled: true

connections:
  - id: my-bitbucket
    kind: bitbucket-server
    base_url: https://bitbucket.example.com
    display_name: 公司 Bitbucket
    auth:
      type: pat
      token: <BITBUCKET_HTTP_ACCESS_TOKEN>
    clone:
      protocol: pat
  - id: my-github
    kind: github
    base_url: https://api.github.com
    display_name: GitHub
    auth:
      type: pat
      token: <GITHUB_PERSONAL_ACCESS_TOKEN>
    clone:
      protocol: pat

active_connection_id: my-bitbucket

llm:
  active_id: default
  context_tokens: 128000
  profiles:
    - id: default
      label: OpenAI
      provider: openai
      base_url: ''
      model: gpt-4o
      api_key: <OPENAI_API_KEY>
```

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `language` | string | `''`（自动） | 界面与 pr-agent 生成内容使用的语言（ISO locale，如 `zh-CN` / `en-US` / `ja-JP` / `de-DE`）。**默认空 = 自动**：按系统偏好语言匹配，无合适项回落英语。设置页可切换（热生效）。 |
| `appearance` | object | — | 界面与编辑器外观（主题 / 字体），见下。 |
| `workspace` | object | — | 工作目录设置，见下。 |
| `agent` | object | — | 高阶 Agent 与 AutoPilot 设置（Agent 目录、个性化规则均归于此），见下。 |
| `poller` | object | — | PR 轮询设置，见下。 |
| `proxy` | object | — | 出站网络代理设置，见下（详见 [网络代理配置](03-proxy.md)）。 |
| `pr_agent` | object | — | pr-agent 运行时设置，见下。 |
| `notifications` | object | — | 系统通知与 dock 角标设置，见下。 |
| `service` | object | — | 本地 API 服务（CLI / 外部集成入口）设置，见下（详见 [CLI 命令行工具](06-cli.md)）。 |
| `update` | object | — | 版本更新检测设置，见下。 |
| `connections` | array | `[]` | 代码平台连接列表，见下（详见 [代码平台配置](01-code-platform.md)）。 |
| `active_connection_id` | string | `''` | 当前启用的连接 `id`，见下。 |
| `llm` | object | — | LLM 预设设置，见下（详见 [LLM 配置](02-llm.md)）。 |

## `appearance` — 外观

界面与编辑器的纯前端展示项（主进程仅据主题设原生窗口明暗）。均在设置页可视化调整、即时生效。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `editor_theme` | enum | `auto` | 全局主题（Monaco 编辑器与整个界面共用）：`auto` 跟随系统深 / 浅色，其余为内置 / 第三方主题 id。 |
| `editor_font_family` | string | `''` | 编辑器等宽字体族（CSS font-family，可逗号分隔多候选）。留空 = 内置 mono 字体栈。 |
| `editor_font_size` | integer | `14` | 编辑器字号（px），限合理范围。 |

## `workspace` — 工作目录

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repos_dir` | string | `~/.code-meeseeks/repos` | 仓库本地镜像（bare clone）的存放目录。改动需重启应用后完全生效。支持 `~` 展开。 |

## `agent` — 高阶 Agent 与 AutoPilot

高阶 Agent 把自然语言请求转成自主规划 + 多工具编排（设计见 [docs/arch/02-agent/01-agent.md](../arch/02-agent/01-agent.md)）。**Agent 目录** `<agent.dir>/` 是 Agent 的完整人格与知识来源，其固定布局为：

```
<agent.dir>/
├── SOUL.md      # 灵魂：核心职责与边界（只读）
├── AGENTS.md    # 工作规范与红线
├── MEMORY.md    # 长期记忆（可写）
├── USER.md      # 用户画像（可写）
└── rules/       # 个性化规则目录（原 rules.dir 并入此处，结构见 自定义评审规则）
```

Agent **无独立启用开关**——配置了 LLM 且 pr-agent 就绪即可用。`dir` 留空时回落到工作目录下的默认位置 `~/.code-meeseeks/agent`（启动期幂等脚手架自动补齐缺失文件）；配自定义路径可指向一个 git 仓库，便于团队共享上下文与规则。

> **从旧 `rules.*` 迁移**：早期版本的个性化规则配置在顶层 `rules.dir`；现已并入 `<agent.dir>/rules/`，**不再读取旧 `rules.*` 字段**。把原规则目录的内容移入 `<agent.dir>/rules/` 即可（规则文件结构不变，见 [自定义评审规则](05-rules.md)）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dir` | string | `''` | Agent 目录路径。留空 = 工作目录下默认 `~/.code-meeseeks/agent`。支持 `~` 展开。可指向 git 仓库以共享。 |
| `max_steps` | integer | `8` | 单次会话的 Agent 规划步数上限，`1`–`50`。 |
| `summary_max_chars` | integer | `800` | 收尾总结的严格篇幅上限（字符），`100`–`4000`。 |
| `autopilot` | object | — | AutoPilot 预评审设置，见下。 |
| `strategy` | object | — | Agent 行为策略（作用于手动自动评审与 AutoPilot），见下。 |

### `agent.autopilot` — AutoPilot 预评审

轮询发现待评审 PR 后自动预跑 `/describe` + `/review`，进应用即见待确认草稿（决策权仍在评审者）。准入控制只放行「待我评审·待处理」且未评审过的 PR，PR 被移除 / purge 即终止在途任务。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | AutoPilot 总开关。状态栏可切换；`false` 时调度逻辑完全不跑。 |
| `batch_size` | integer | `10` | 单批 LLM 判定的 PR 上限，`1`–`50`。 |
| `grants` | array | `[]` | 逐项写权限授权（默认空 = 全拒），如 `approve` / `needs_work` / `publish_comment`；运行期按红线硬校验放行。 |

### `agent.strategy` — Agent 行为策略

作用于自动评审微流程（手动「自动评审」与 AutoPilot 共用），非 AutoPilot 专属。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `auto_followup` | boolean | `true` | 评审阶段是否启用**自动追问**（条件性 `/ask`）。关闭则跳过判读 + 追问、直接总结，省一次 LLM 调用与追问开销。 |
| `max_followup_asks` | integer | `2` | 自动追问数量上限（条件性 `/ask` 的硬上限），`0`–`5`。仅 `auto_followup` 开启时生效；`0` 等同关闭。 |
| `max_code_suggestions` | integer | `4` | 单次 `/review`、`/improve`、`/ask` 生成的代码建议数量上限，`2`–`8`。 |

## `poller` — PR 轮询

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `interval_seconds` | integer | `300` | 自动轮询拉取待评审 PR 的间隔秒数，最小 `30`。 |

## `proxy` — 出站网络代理

开启后 LLM 调用、代码平台 REST、git HTTPS 统一经代理；loopback / 本地地址（含本地 Ollama）自动直连。SSH 方式的 git 拉取不走此配置，需在 `~/.ssh/config` 自配。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 代理总开关。关闭 = 全部直连。 |
| `protocol` | enum | `http` | 当前仅支持 `http`。 |
| `host` | string | `''` | 代理主机地址。 |
| `port` | integer | `8080` | 代理端口，`1`–`65535`。 |
| `username` | string | `''` | Basic Auth 用户名，无鉴权留空。 |
| `password` | string | `''` | Basic Auth 密码，无鉴权留空。 |

## `pr_agent` — 运行时

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `strategy` | enum | `auto` | 运行时策略：`auto` 优先随包内嵌运行时、缺失则回退系统 `pr-agent` CLI；亦可显式 `embedded` / `local-cli` 强制。 |
| `max_concurrency` | integer | `2` | 评审任务并发数，`1`–`8`。设置页「AI」分区可调（热生效，无需重启），亦可手改本文件，详见 [LLM 配置 · 进阶：评审并发数](02-llm.md#进阶评审并发数)。 |

## `notifications` — 消息通知

系统通知（toast）与 macOS dock「待回应」角标开关。`enabled` 为总开关（关闭后既不弹通知也不亮角标）；其余各项按事件类型分别控制系统通知——`new_pr` / `reply` / `mention` 面向「待我评审」等场景，`authored_*` 面向「我创建的」PR。系统通知受 OS 权限约束，用户在系统设置关闭后应用静默降级。设置页可调，即时生效。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 通知总开关；关闭后不弹系统通知、不亮 dock 角标。 |
| `new_pr` | boolean | `true` | 出现新的待我评审 PR 时弹通知。 |
| `reply` | boolean | `true` | 收到评论回复时弹通知。 |
| `mention` | boolean | `true` | 评论中被 @ 提及时弹通知。 |
| `authored_comment` | boolean | `true` | 我创建的 PR 收到他人新评论时弹通知。 |
| `authored_needs_work` | boolean | `true` | 我创建的 PR 被评审标记「需修改」时弹通知。 |
| `authored_conflict` | boolean | `true` | 我创建的 PR 出现合并冲突时弹通知。 |

## `service` — 本地 API 服务

本机 HTTP API 服务监听配置，供 `meebox` CLI 与外部脚本 / agent 访问应用能力（详见 [CLI 命令行工具](06-cli.md)）。默认关闭、零暴露面；开启即**强制** bearer token 鉴权。设置页「集成」分区可视化开关、查看 / 复制 / 重新生成令牌，即时生效（开关 / 地址 / 端口变更停旧起新，token 变更下次请求生效）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 服务总开关。关闭 = 不监听、无暴露面。 |
| `host` | string | `127.0.0.1` | 监听地址。默认仅本机可达；设 `0.0.0.0` 暴露到局域网（高风险，此时令牌是唯一防线）。 |
| `port` | integer | `18765` | 监听端口，`1`–`65535`。 |
| `token` | string | `''` | 访问令牌（bearer）。首次开启自动生成；设置页可重新生成（旧令牌即时失效）。以明文保存。 |

## `update` — 版本更新检测

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `check_enabled` | boolean | `true` | 启动时（及设置页手动触发）查 GitHub Releases 最新稳定版并与当前版本比对，有新版仅**提示**去下载（不自动下载 / 安装）。设为 `false` 关闭检测——此开关仅经手改本文件调整（设置页展示更新状态、不提供开关）。 |

## `connections` — 代码平台连接

`connections` 是数组，每个元素是一条连接。`kind` 决定平台类型与字段形态。

### 公共字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 连接唯一标识，被 `active_connection_id` 引用。 |
| `kind` | enum | 平台类型：`github` / `bitbucket-server` / `gitlab`。 |
| `display_name` | string | 显示名称（设置页与状态栏展示）。 |
| `auth.type` | literal | 固定 `pat`。 |
| `auth.token` | string | 访问令牌（PAT）。所需权限见 [代码平台配置](01-code-platform.md)。 |
| `clone.protocol` | enum | git 克隆协议：`pat`（默认，HTTPS，URL 内嵌用户名 + PAT）/ `ssh`（走系统 `~/.ssh/config`）。 |

### `kind: github`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `base_url` | string (URL) | GitHub API base。**可选**：留空默认 `https://api.github.com`（github.com）；GitHub Enterprise Server 填实例地址 `https://<ghe-host>`，`/api/v3` 自动补全（手填完整 API base 亦可）。clone / web 域名由应用自动推导。 |

### `kind: bitbucket-server`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `base_url` | string (URL) | Bitbucket Server / Data Center 地址，如 `https://bitbucket.example.com`。**必填**。 |

### `kind: gitlab`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `base_url` | string (URL) | GitLab API base。**可选**：留空默认 `https://gitlab.com/api/v4`（gitlab.com）；Self-Managed 填实例地址 `https://<gitlab-host>`，`/api/v4` 自动补全（手填完整 API base 亦可）。clone / web 域名由应用自动推导。 |

## `active_connection_id` — 当前启用连接

| 类型 | 默认 | 说明 |
| --- | --- | --- |
| string | `''` | 取值为某条连接的 `id`。同时只启用一条：仅这条被轮询，PR 列表与状态栏只反映它。空串 / 指向不存在的 id 时不轮询任何连接（由界面引导启用一条）。`connections` 仍保留全部配置，历史 PR 不受影响。 |

## `llm` — LLM 预设

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `profiles` | array | `[]` | LLM 预设列表，每条独立 provider / model / base_url / api_key。 |
| `active_id` | string | `''` | 当前生效的预设 `id`。空串 / 指向不存在的 id 时，评审不注入任何 LLM 环境变量（pr-agent 退回读取 shell 环境变量）。 |
| `context_tokens` | integer | `128000` | 裁剪输入内容的上下文长度上限（token），`32000`–`1000000`。超长改动按此截断以适配模型。**对本地 CLI 模式不生效**（CLI 工具自管上下文）。设置页「AI」分区可调（下次评审生效）。 |

### 单条预设（`profiles[]`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | — | 预设唯一标识，被 `active_id` 引用。 |
| `label` | string | `''` | 显示名称，留空时界面用 provider + model 兜底。 |
| `provider` | enum | `openai-compatible` | 服务商：`openai` / `anthropic` / `deepseek` / `dashscope`（阿里百炼）/ `volcengine-ark`（火山方舟）/ `openai-compatible`（任意 OpenAI 协议兼容服务，含本地 Ollama 的 `/v1`）/ `cli`（本机 agentic CLI，不直连 API）。旧值 `ollama` 自动迁移为 `openai-compatible`。 |
| `base_url` | string | `''` | API 端点。多数官方 provider 留空走默认；`openai-compatible` / 自部署需填。 |
| `model` | string | `''` | 模型名。多数 provider 只填型号名，应用按 provider 自动补 litellm 前缀；`cli` 模式此处填命令名（如 `claude`）。 |
| `api_key` | string | `''` | 鉴权密钥。本地类（本地 CLI / 无鉴权自建服务）留空。 |

各 provider 的取值示例与本地 CLI 模式说明见 [LLM 配置](02-llm.md)。
