# LLM 配置

评审内容由 LLM 生成（底层走 pr-agent + litellm）。在 **设置 → LLM** 配置一条或多条「LLM 预设」，用 `active` 切换当前生效的那条。每条预设独立保存 服务商 / 模型 / Base URL / API Key。

## 预设字段

| 字段 | 说明 |
| --- | --- |
| 名称 | 预设标识（字母 / 数字 / `-` / `_`，1–32 字符），用于切换与日志 |
| Provider | LLM 服务商，决定鉴权与路由方式（见下表） |
| Model | 模型名（多数 provider 只填型号名，客户端自动补 litellm 前缀） |
| Base URL | API 端点；多数官方 provider 有默认值，留空即可 |
| API Key | 鉴权密钥；本地类（Ollama / CLI）不需要 |

## Provider 一览

| Provider | 说明 | Model 示例 | 需 Key | Base URL |
| --- | --- | --- | --- | --- |
| OpenAI | 官方 OpenAI API | `gpt-4o` / `gpt-4o-mini` | 是 | 默认 endpoint，留空 |
| Anthropic | 官方 Anthropic API | `claude-opus-4-8` / `claude-sonnet-4-6` | 是 | 默认 |
| DeepSeek | 官方 DeepSeek API | `deepseek-v4-pro` / `deepseek-v4-flash` | 是 | 默认 |
| 阿里百炼 (DashScope) | OpenAI 兼容入口，含千问 / DeepSeek-on-DashScope | `qwen-max` / `qwen-plus` | 是 | 已内置默认 |
| 火山方舟 (Volcengine Ark) | OpenAI 兼容入口，含豆包 / DeepSeek-on-Ark | `ep-xxxxx` / `doubao-pro-32k` | 是 | 已内置默认 |
| Ollama | 本地 Ollama 服务 | `qwen2.5` / `llama3.1` | 否 | `http://localhost:11434` |
| OpenAI 兼容 | 任意遵循 OpenAI 协议的服务（vLLM / 自建代理 / 中转） | 平台特定 | 是 | **必填** |
| **本地 CLI** | 用本机 agentic CLI 执行评审，**不直连 API**（**实验性**，见下文） | `claude` / `codex` | 否 | 不适用 |

> **关于模型前缀**：各 provider 只需填模型名，客户端会按 provider 自动补全 litellm 路由前缀；已手动带前缀的不会重复添加。
>
> - Anthropic → 默认补 `anthropic/`
> - DeepSeek → 默认补 `deepseek/`
> - Ollama → 默认补 `ollama/`
> - OpenAI 兼容 / 阿里百炼 / 火山方舟 → 默认补 `openai/`
> - OpenAI → 直接使用内置模型名，不加前缀
> - 本地 CLI → 填的是命令名，不涉及前缀

## 本地 CLI 模式

进阶选项：不直连任何 LLM API，而是经你授权调用本机已安装并登录的 **agentic CLI**（当前支持 `claude` / `codex`），在本地子进程中执行评审。该 CLI 以其自身的登录会话与计费策略运行，相关额度与合规由你自行负责。

> 🧪 **实验性能力**：本地 CLI 模式依赖第三方 CLI 的命令行接口与输出格式，这些**不在本项目控制范围内**。上游 CLI 的版本更新可能更改参数、输出结构或登录 / 计费策略，导致本模式行为变化甚至无法持续工作；本项目不对其稳定性与持续可用性作担保。设置页对该类预设标注「实验性」徽标以示提醒。若评审异常，请优先核对所用 CLI 的版本与登录态。
>
> **完全由你授权**：仅当你新建并启用此预设、在 **CLI 命令** 字段填入命令名后，客户端才会调用对应命令行；这一行为完全出于你的显式授权，并使用你本机的登录态。

### 配置方法

1. 在本机安装对应 CLI 并完成登录。
2. 进入 设置 → LLM，新建预设，**Provider 选「本地 CLI」**。
3. 在 **CLI 命令** 字段填入命令名，如 `claude` 或 `codex`。
4. 保存并设为 active。

### 关键行为

- **以本机登录态运行**：评审请求交由本机 CLI 处理，沿用其默认模型与登录会话，不使用此处或环境中的 API Key。
- **实际模型**：由本机 CLI 的默认模型 / 账户档位决定，**不由此处输入决定**（此处填写的是命令名，非模型名）。
- **代理自动透传**：开启[网络代理](03-proxy.md)后，CLI 的出站请求会自动经代理，无需额外配置。

> 前提：本机须已安装对应命令、位于 PATH 中且已登录，否则评审会因找不到命令而失败；评审消耗计入该 CLI 账户自身的额度。

## 进阶：评审并发数

应用支持多个评审任务**并发执行**（例如同时对多个 PR 跑 `/review`，互不阻塞）。并发数由配置项 `pr_agent.max_concurrency` 控制，**默认 2**，取值范围 **1~8**。

该参数为高级选项，**不在设置页展示**，需手动编辑 `~/.code-meeseeks/config.yaml`（设置页提供「用系统关联程序打开 config.yaml」）：

```yaml
pr_agent:
  max_concurrency: 3   # 1~8，默认 2
```

调高的注意事项（按此判断设多少）：

- **LLM 限流 / 费用**：并发越高，同一时刻打向 LLM 的请求越多。自带 Key 的付费档位通常可承受 2~3；免费 / 低档位易触发限流（HTTP 429），宜保持 `1`。
- **本地 CLI 模式**：每个并发任务会各起一个本机 CLI 子进程，是否支持多会话取决于该 CLI 本身，建议先小范围验证。
- **本机资源**：每个并发任务占用一个独立运行时进程与一份临时工作目录，并发越高越吃 CPU / 内存 / 磁盘。

> 改动 `config.yaml` 后需重启应用生效。设为 `1` 即退回串行执行（逐个排队）。
