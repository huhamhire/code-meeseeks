# LLM 配置

[English](../02-llm.md) · **简体中文**

评审内容由 LLM 生成（底层走 pr-agent + litellm）。在 **设置 → LLM** 配置一条或多条「LLM 预设」，用 `active` 切换当前生效的那条。每条预设独立保存 服务商 / 模型 / Base URL / API Key。

## 预设字段

| 字段 | 说明 |
| --- | --- |
| 名称 | 预设标识（字母 / 数字 / `-` / `_`，1–32 字符），用于切换与日志 |
| Provider | LLM 服务商，决定鉴权与路由方式（见下表） |
| Model | 模型名（多数 provider 只填型号名，客户端自动补 litellm 前缀） |
| Base URL | API 端点；多数官方 provider 有默认值，留空即可 |
| API Key | 鉴权密钥；本地类（本地 CLI / 自建无鉴权服务）不需要 |

## Provider 一览

| Provider | 说明 | Model 示例 | 需 Key | Base URL |
| --- | --- | --- | --- | --- |
| OpenAI | 官方 OpenAI API | `gpt-4o` / `gpt-4o-mini` | 是 | 默认 endpoint，留空 |
| Anthropic | 官方 Anthropic API | `claude-opus-4-8` / `claude-sonnet-4-6` | 是 | 默认 |
| DeepSeek | 官方 DeepSeek API | `deepseek-v4-pro` / `deepseek-v4-flash` | 是 | 默认 |
| 阿里百炼 (DashScope) | OpenAI 兼容入口，含千问 / DeepSeek-on-DashScope | `qwen-max` / `qwen-plus` | 是 | 已内置默认 |
| 火山方舟 (Volcengine Ark) | OpenAI 兼容入口，含豆包 / DeepSeek-on-Ark | `ep-xxxxx` / `doubao-pro-32k` | 是 | 已内置默认 |
| OpenAI 兼容 | 任意遵循 OpenAI 协议的服务（vLLM / 自建代理 / 中转 / **本地 Ollama**） | 平台特定 | 视服务而定 | **必填** |
| **本地 CLI** | 用本机 agentic CLI 执行评审，**不直连 API**（**实验性**，见下文） | `claude` / `codex` | 否 | 不适用 |

> **关于模型前缀**：各 provider 只需填模型名，客户端会按 provider 自动补全 litellm 路由前缀；已手动带前缀的不会重复添加。
>
> - Anthropic → 默认补 `anthropic/`
> - DeepSeek → 默认补 `deepseek/`
> - OpenAI 兼容 / 阿里百炼 / 火山方舟 → 默认补 `openai/`
> - OpenAI → 直接使用内置模型名，不加前缀
> - 本地 CLI → 填的是命令名，不涉及前缀

## 配置示例

按 Provider 给出设置页各字段的填法（**名称**仅作标识、随意取；除特别说明外 Model 只填型号名，路由前缀客户端自动补全）。

### OpenAI

- Provider：`OpenAI`
- Model：`gpt-4o-mini`
- Base URL：留空（默认 `https://api.openai.com`）
- API Key：`sk-…`

### Anthropic

- Provider：`Anthropic`
- Model：`claude-sonnet-4-6`
- Base URL：留空
- API Key：`sk-ant-…`

### DeepSeek

- Provider：`DeepSeek`
- Model：`deepseek-v4-pro`
- Base URL：留空
- API Key：`sk-…`

### 阿里百炼（DashScope）

- Provider：`阿里百炼`
- Model：`qwen-plus`
- Base URL：留空（已内置默认）
- API Key：DashScope 密钥

### 火山方舟（Volcengine Ark）

- Provider：`火山方舟`
- Model：`doubao-pro-32k`（或推理接入点 `ep-…`）
- Base URL：留空（已内置默认）
- API Key：Ark 密钥

### OpenAI 兼容（自建 / 中转 / 本地 Ollama）

Provider 选 **OpenAI 兼容**，Base URL **必填**为目标服务的 `/v1` 端点，Model 填平台特定型号名。两个常见场景：

**自建 vLLM / 中转**

- Provider：`OpenAI 兼容`
- Model：`qwen2.5-72b-instruct`
- Base URL：`http://10.0.0.5:8000/v1`
- API Key：视服务而定（无鉴权留空）

**本地 Ollama**

- Provider：`OpenAI 兼容`
- Model：`qwen2.5`（需先 `ollama pull`）
- Base URL：`http://localhost:11434/v1`
- API Key：留空

> Ollama 自带 OpenAI 兼容端点，走此路径即可，无需单独渠道（旧 `ollama` 预设升级后自动迁移为此形态）。

> **本地 CLI** 预设的配置见下方独立章节。

## 本地 CLI 模式

进阶选项：不直连任何 LLM API，而是经你授权调用本机已安装并登录的 **agentic CLI**（当前支持 `claude` / `codex`），在本地子进程中执行评审。该 CLI 以其自身的登录会话与计费策略运行，相关额度与合规由你自行负责。

> 🧪 **实验性能力**：本地 CLI 模式依赖第三方 CLI 的命令行接口与输出格式，这些**不在本项目控制范围内**。上游 CLI 的版本更新可能更改参数、输出结构或登录 / 计费策略，导致本模式行为变化甚至无法持续工作；本项目不对其稳定性与持续可用性作担保。设置页对该类预设标注「实验性」徽标以示提醒。若评审异常，请优先核对所用 CLI 的版本与登录态。
>
> **完全由你授权**：仅当你新建并启用此预设、在 **CLI 命令** 字段填入命令名后，客户端才会调用对应命令行；这一行为完全出于你的显式授权，并使用你本机的登录态。

### 配置方法

1. 在本机安装对应 CLI 并完成登录。
2. 进入 设置 → LLM，新建预设，**Provider 选「本地 CLI」**。
3. 在 **CLI 命令** 字段填入命令名，如 `claude` 或 `codex`。
4. 可选填写**附加参数**，例如 Codex 使用 `--model gpt-6.1-sol -c model_reasoning_effort=medium`，Claude 使用 `--model sonnet --effort medium`。含空格的值使用引号组合，换行与空格一样用于分隔参数；预览显示解析后的参数数组。不支持 shell 展开或 shell 命令。
5. 保存并设为 active。

### 关键行为

- **以本机登录态运行**：评审请求交由本机 CLI 处理，使用选定模型与 CLI 登录会话，不使用此处或环境中的 API Key。
- **实际模型**：附加参数仅为当前预设覆盖 CLI 本地默认配置；未填写时沿用 CLI 自身配置。命令字段仍只填写命令名，模型可用性仍取决于 CLI 账号及版本。
- **支持的参数**：Codex 支持 `--model` / `-m`，以及通过 `--config` / `-c` 设置 `model`、`model_reasoning_effort`、`service_tier`、`model_verbosity`；Claude 支持 `--model`、`--effort`、`--max-turns`、`--max-budget-usd`、`--fallback-model`。兼容 `--option value` 和 `--option=value`。输入输出协议、沙箱、工作目录、提示词和子命令由应用管理，不允许覆盖。
- **范围与优先级**：参数用于描述、评审、问答、代码建议及 Agent 编排聊天。显式设置 Codex 推理强度后，不再自动覆盖为低强度；显式设置 Claude 模型或推理强度后，不再自动选用 Haiku。留空保留原有行为，参数以预设中的 `cli_args: string[]` 保存。自定义 Windows 批处理启动器拒绝 shell 元字符，原生及标准 npm 启动器直接传递参数值。
- **代理自动透传**：开启[网络代理](03-proxy.md)后，CLI 的出站请求会自动经代理，无需额外配置。

> 前提：本机须已安装对应命令、位于 PATH 中且已登录，否则评审会因找不到命令而失败；评审消耗计入该 CLI 账户自身的额度。

## PR Agent 自动评审

在 PR Agent 中打开状态栏的模型菜单，点击 Codex CLI 预设可打开二级菜单。选定具体型号或 **CLI 默认模型**后，选择会保存在该预设中，其余 CLI 参数会保留。

点击**自动评审**，生成 PR 描述、评审变更并给出最终总结。评审保留作者的 PR 描述，并排除已有评论和回复。提问时仍可主动引用某条评论。

生成的 PR 描述说明行为和流程的变化。在 **Diff** 中选择文件后，如果生成结果覆盖该文件及当前比较范围，页眉下方会显示**变更说明**。展开评审结果中的**文件变更**可查看完整清单。

简短的最终总结前会集中展示去重后的代码反馈。当前版本中有可用行号的反馈可快捷创建行内评论草稿。PR Agent 的反馈即使缺少已验证的行号，仍可引用追问。旧版本的反馈仍会显示，并附有版本提示。被追问替代或关闭的反馈会从清单中移除。展开**评审过程**可查看原始结果。可按问题等级优先查看反馈，P1 需要追问引用本轮评审提交中的证据。等级标签提供模型判断的触发条件和后果。

阅读改动时，可用 Diff 右上角的**内嵌评论**按钮隐藏已发布的行内评论。仍可查看本地草稿或添加评论。应用会记住此设置。

## Codex 原生评审

安装兼容的 Codex CLI 并登录。桌面应用会在启动和窗口重新获得焦点时自动检测。打开 PR 后，从 **PR Agent** 切换到 **Codex**，点击**运行 Codex 评审**。Codex 会评审整个 PR。

点击 **/** 菜单或输入 `/` 可查看命令提示。发送 `/review` 可评审整个 PR，发送 `/ask <问题>` 可询问本次变更，也可以直接输入问题。

发送 `/approve` 可在代码托管平台标记 PR 为通过，发送 `/needswork` 可标记为需修改。这两个命令与 PR 顶部按钮共用评审操作，Codex 运行期间也可使用。

模型选择器位于**发送**按钮左侧。打开标签页时先显示上次成功获取的模型列表，首次使用也可从本机 CLI 缓存读取候选项。列表在后台刷新，刷新失败时仍可选择缓存中的模型。应用重启后会恢复上次选择。没有可用的已保存型号时，会选择最新的可用 Sol，其次是列表中的第一项。没有可用列表条目时，Codex 使用 CLI 默认模型。

可直接询问 PR，也可点击评审发现上的引用按钮追问。追问会带上当前对比版本的近期对话，并可读取临时检出中的代码。评审和回答均跟随应用语言。运行卡片显示评审阶段和 CLI 提供的进度摘要。Codex 标签页有独立的评审历史。定位到有效 diff 行的发现可转为评论草稿，由你编辑或发布。该标签页属于桌面功能。需要原生评审的自动化可直接调用 Codex。

## 进阶：评审并发数

应用支持多个评审任务**并发执行**（例如同时对多个 PR 跑 `/review`，互不阻塞）。并发数由配置项 `pr_agent.max_concurrency` 控制，**默认 2**，取值范围 **1~8**。

在设置页「AI」分区拖动「评审任务并发」滑块即可调整（热生效，无需重启）；亦可手动编辑 `~/.code-meeseeks/config.yaml`：

```yaml
pr_agent:
  max_concurrency: 3   # 1~8，默认 2
```

调高的注意事项（按此判断设多少）：

- **LLM 限流 / 费用**：并发越高，同一时刻打向 LLM 的请求越多。自带 Key 的付费档位通常可承受 2~3；免费 / 低档位易触发限流（HTTP 429），宜保持 `1`。
- **本地 CLI 模式**：每个并发任务会各起一个本机 CLI 子进程，是否支持多会话取决于该 CLI 本身，建议先小范围验证。
- **本机资源**：每个并发任务占用一个独立运行时进程与一份临时工作目录，并发越高越吃 CPU / 内存 / 磁盘。

> 设置页调整即时生效（调小不打断在跑的任务，随其完成自然收敛）；手改 `config.yaml` 后需重启应用生效。设为 `1` 即退回串行执行（逐个排队）。

## 进阶：上下文长度

评审前会把改动内容（diff、命中规则、PR 上下文等）拼成 prompt 发给模型。当输入超过模型上下文窗口时，pr-agent 会**按上下文长度上限裁剪**输入以适配模型。该上限由配置项 `llm.context_tokens` 控制，**默认 128000**（token），取值范围 **32k~1M**。

在设置页「AI」分区拖动「上下文长度」滑块即可调整（下次评审生效），提供 32k / 64k / 128k / 256k / 512k / 1M 等主要习惯档位；亦可手动编辑 `~/.code-meeseeks/config.yaml`：

```yaml
llm:
  context_tokens: 256000   # 32000~1000000，默认 128000
```

- 设置得**与所用模型的实际上下文窗口相称**：超过模型能力时上游会报错；设得过小则长 PR 会被提前截断、漏看部分改动。
- **对本地 CLI 模式不生效**：本地 CLI（如 claude）自行管理上下文，本项不参与裁剪。
