# 配置文件参考

所有配置集中在唯一的配置文件 **`~/.code-meeseeks/config.yaml`**（YAML 格式）。日常使用通过应用内 **设置** 页与首启向导可视化编辑即可，无需手动改文件；本篇是完整的结构与字段参考，供批量配置、高级参数调整、问题排查时查阅。

- **编辑方式**：设置页保存即写盘并热更新；设置页「用系统关联程序打开 config.yaml」可直接编辑文件。
- **生效时机**：连接 / LLM / 代理等改动保存后即时重建生效；个别高级参数（如并发数、缓存目录）需重启应用。
- **凭据说明**：访问令牌、API Key、代理密码以**明文**保存在本文件中（与配置结构隔离但不加密）。请按最小权限申请凭据、妥善保护本文件，泄露后及时吊销。

## 完整示例

```yaml
language: zh-CN

workspace:
  repos_dir: ~/.code-meeseeks/repos

rules:
  dir: ''
  enabled: true

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
| `language` | string | `zh-CN` | pr-agent 生成评审内容使用的自然语言（ISO locale，如 `zh-CN` / `en-US`）。设置页暂不暴露，需手改。 |
| `workspace` | object | — | 工作目录设置，见下。 |
| `rules` | object | — | 个性化规则目录设置，见下。 |
| `poller` | object | — | PR 轮询设置，见下。 |
| `proxy` | object | — | 出站网络代理设置，见下（详见 [网络代理配置](03-proxy.md)）。 |
| `pr_agent` | object | — | pr-agent 运行时设置，见下。 |
| `connections` | array | `[]` | 代码平台连接列表，见下（详见 [代码平台配置](01-code-platform.md)）。 |
| `active_connection_id` | string | `''` | 当前启用的连接 `id`，见下。 |
| `llm` | object | — | LLM 预设设置，见下（详见 [LLM 配置](02-llm.md)）。 |

## `workspace` — 工作目录

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repos_dir` | string | `~/.code-meeseeks/repos` | 仓库本地镜像（bare clone）的存放目录。改动需重启应用后完全生效。支持 `~` 展开。 |

## `rules` — 个性化规则

规则目录下每个 `.md` 文件即一条规则：frontmatter（YAML）声明命中范围（项目 / 仓库 / 目标分支）、适用工具、优先级，正文作为 `extra_instructions` 注入 pr-agent。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dir` | string | `''` | 规则目录路径。留空 = 不启用。建议指向一个 git 仓库，便于团队共享规约。 |
| `enabled` | boolean | `true` | 全局开关。`dir` 已配置但 `enabled: false` 时跳过加载（应急关闭用）。 |

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
| `max_concurrency` | integer | `2` | 评审任务并发数，`1`–`8`。高级参数，不在设置页暴露，详见 [LLM 配置 · 进阶：评审并发数](02-llm.md#进阶评审并发数)。改动需重启。 |

## `connections` — 代码平台连接

`connections` 是数组，每个元素是一条连接。`kind` 决定平台类型与字段形态。

### 公共字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 连接唯一标识，被 `active_connection_id` 引用。 |
| `kind` | enum | 平台类型：`bitbucket-server` / `github`。 |
| `display_name` | string | 显示名称（设置页与状态栏展示）。 |
| `auth.type` | literal | 固定 `pat`。 |
| `auth.token` | string | 访问令牌（PAT）。所需权限见 [代码平台配置](01-code-platform.md)。 |
| `clone.protocol` | enum | git 克隆协议：`pat`（默认，HTTPS，URL 内嵌用户名 + PAT）/ `ssh`（走系统 `~/.ssh/config`）。 |

### `kind: bitbucket-server`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `base_url` | string (URL) | Bitbucket Server / Data Center 地址，如 `https://bitbucket.example.com`。**必填**。 |

### `kind: github`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `base_url` | string (URL) | GitHub REST API base。**可选**：留空默认 `https://api.github.com`（github.com）；GitHub Enterprise Server 填 `https://<ghe-host>/api/v3`。clone / web 域名由应用自动推导。 |

## `active_connection_id` — 当前启用连接

| 类型 | 默认 | 说明 |
| --- | --- | --- |
| string | `''` | 取值为某条连接的 `id`。同时只启用一条：仅这条被轮询，PR 列表与状态栏只反映它。空串 / 指向不存在的 id 时不轮询任何连接（由界面引导启用一条）。`connections` 仍保留全部配置，历史 PR 不受影响。 |

## `llm` — LLM 预设

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `profiles` | array | `[]` | LLM 预设列表，每条独立 provider / model / base_url / api_key。 |
| `active_id` | string | `''` | 当前生效的预设 `id`。空串 / 指向不存在的 id 时，评审不注入任何 LLM 环境变量（pr-agent 退回读取 shell 环境变量）。 |

### 单条预设（`profiles[]`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | — | 预设唯一标识，被 `active_id` 引用。 |
| `label` | string | `''` | 显示名称，留空时界面用 provider + model 兜底。 |
| `provider` | enum | `openai-compatible` | 服务商：`openai` / `anthropic` / `deepseek` / `dashscope`（阿里百炼）/ `volcengine-ark`（火山方舟）/ `ollama` / `openai-compatible`（任意 OpenAI 协议兼容服务）/ `cli`（本机 agentic CLI，不直连 API）。 |
| `base_url` | string | `''` | API 端点。多数官方 provider 留空走默认；`openai-compatible` / 自部署需填。 |
| `model` | string | `''` | 模型名。多数 provider 只填型号名，应用按 provider 自动补 litellm 前缀；`cli` 模式此处填命令名（如 `claude`）。 |
| `api_key` | string | `''` | 鉴权密钥。本地类（Ollama / CLI）留空。 |

各 provider 的取值示例与本地 CLI 模式说明见 [LLM 配置](02-llm.md)。
