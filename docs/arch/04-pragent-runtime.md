# 04 · pr-agent 集成与运行时

## 职责与边界

把第三方的 pr-agent（Python）接进来跑 `/describe` `/review` `/ask`，并解决「运行时从哪来、怎么无侵入
改它的行为、怎么拿真实 token 用量」。

负责：调用桥（多策略）、随 app 打包的嵌入式 Python 运行时、对 pr-agent 的 monkeypatch 补丁体系、
token 用量采集、注入 env。不负责：输出解析与草稿（见 [05](05-review-workflow.md)）、git/worktree（见 [02](02-repo-mirror.md)）。

## 核心设计

### 调用桥（策略模式）

`PrAgentBridge` 两种策略，启动探测自动选、设置页可强制：

- **embedded（默认）**：用随 app 打包的嵌入式解释器跑 `python -m pr_agent.cli`，免用户装任何东西。
- **local-cli**：用系统 `pr-agent` CLI（高级用户自管 Python）。

> Docker 策略已移除：容器文件系统装载效率低、与「零依赖」定位不符，嵌入式本地进程已覆盖全部场景。

统一以 **LocalGitProvider 模式**在物化好的 worktree 上跑（`CONFIG__GIT_PROVIDER=local`，cwd=worktree）。
注意 pr-agent 社区版 LocalGitProvider 的反直觉点：`--pr_url` 槽位填的是 **target 分支名**（不是 URL），
仓库根靠 cwd 的 `.git` 父目录定位。输出不走 stdout——pr-agent 把结果**写到 worktree 根的 markdown 文件**
（`/describe`→`description.md`、`/review` `/ask`→`review.md`），收尾从文件读，stdout 仅留作日志。

升级 pr-agent ≈ 改版本号，对主体代码零影响（这是选「外挂进程」而非「TS 重写」的根本原因）。

### 嵌入式运行时

随 app 打包**可重定位的 CPython**（python-build-standalone 的 install_only 构建）+ 构建期隔离安装
**pinned 版本的 pr-agent**。组装脚本按一份 manifest（pin 的 python 版本 + pr-agent 版本）下载解释器、
`pip install pr-agent==<ver>`、注入 shim、做 `import pr_agent` 冒烟。运行时作为 `extraResources` 落在
asar 之外（原生解释器 + `.so/.pyd` 必须是真实文件）。由构建机宿主平台组装，与目标平台一致。

### monkeypatch shim（无侵入改 pr-agent）

集中管理**所有**对 pr-agent 的行为改造，上游源码保持原封。源码在 `apps/desktop/scripts/pragent-shim/`：
薄加载器 `sitecustomize.py`（CPython 启动经 `site` 自动 import，无需挂载 / `PYTHONPATH`）+ 按领域拆分的
`meebox_pragent_shim/` 包：

```
meebox_pragent_shim/
├── __init__.py        # apply()：注册全部惰性 post-import hook
├── runtime.py         # finder 注册 · 版本守卫 _EXPECTED_PRAGENT_VERSION · 日志
├── usage.py           # @@MEEBOX_USAGE@@ token 哨兵
├── patches/           # 各 pr_agent 模块的 patch(module)：local_git_provider · litellm_handler · load_yaml
└── cli/               # 本地 CLI provider：parsers · specs(_CLI_SPECS) · install
```

设计原则：

- **惰性 post-import hook**：注册 meta_path finder，仅当目标模块**真正被 import**（= 真实 run）时才打补丁；
  绝不在 sitecustomize 阶段 eager import pr_agent（否则拖慢每次启动/探测/pip）。各 patch 模块对 `pr_agent`
  的 import 一律在 patch 函数体内，顶层只 import 同包的 runtime/usage——故 import 本包不触发 pr_agent 加载。
- **同模块的多个补丁合进一个 patch_fn**：同模块注册多个 finder 会互相遮蔽，只有最前一个生效。
- **版本守卫**：补丁依赖 pr-agent 特定版本内部实现 → 运行期 `_EXPECTED_PRAGENT_VERSION` ≠ 实际安装版本即
  **跳过全部补丁并打 stderr WARNING**（安全降级）；构建期强校验 shim 常量 == manifest 版本，不一致直接 fail。

当前补丁：
- **二进制安全 diff**：原 `get_diff_files` 对每个文件无脑 utf-8 decode，遇二进制崩 → 改为解码失败跳过。
- **anchor 行号**（详见 [05](05-review-workflow.md)）：补 `get_line_link` 返回 `meebox:///<file>#L<s>-L<e>`，
  让 `/review` 的 key_issues 渲染带上结构化 file:line。
- **Anthropic 去 temperature**：新 Claude 型号弃用 temperature，把全 `anthropic/*` 纳入「不发 temperature」集合。
- **load_yaml 容错**：anchor marker 独占一行会破 YAML → 解析失败时剥掉 marker 重试，避免整个 review 崩。
- **本地 CLI provider**：`MEEBOX_CLI_MODE` 置位时整体替换 `chat_completion` 为「调本机 CLI」版（见下）。
- **token usage 采集**：见下。

### 真实 token 用量

inline 包 pr-agent 的 `_get_completion`，从返回的 `response.usage` 取 `prompt/completion/total_tokens`，
以哨兵行 `@@MEEBOX_USAGE@@ {json}` 打到 **stderr**；主进程逐行捕获、按前缀累加、落到 run（见 [05](05-review-workflow.md)）。
**为什么 inline 而非 litellm callback**：litellm 的 async 回调走后台 logging worker，短命 CLI 退出过快会被丢；
inline 在 await 链里必在退出前执行，可靠。只取 token、不取 cost → 统一设 `LITELLM_LOCAL_MODEL_COST_MAP=True`
关掉 litellm 的远端价格表联网（弱网会 SSL 超时）。另在 patch 时置 `litellm.suppress_debug_info=True`：编排 chat
通道以子进程 **stdout** 作模型回复，而 litellm 对未进本地 `model_cost` 表的新模型（如 `claude-opus-4-8`）在 cost/token
计量里调 `get_llm_provider` 失败时会先 `print` 装饰性的「Provider List: …」（ANSI 红字）再抛错（错误被吞、不影响结果），
该 print 会污染 stdout、漏进评审总结——置此开关关掉这些 print。

### 本地 CLI provider

让用户**不填 API key、改用本机已装且已登录的 agentic CLI**（一期仅 **Claude Code**）跑评审。LLM Profile 里
新增 `provider='cli'`，`model` 字段填命令名（`claude`）。其余 provider 走 litellm 直连 API，cli 模式则**完全绕过
litellm**。

- **接入点**：env `MEEBOX_CLI_MODE=1` + `MEEBOX_CLI_BIN=claude`（由 `buildPragentEnv` 注入）→ shim 把
  `LiteLLMAIHandler.chat_completion` 整体换成「起 `claude -p --output-format json` 子进程、prompt 走 stdin、
  解析 JSON 的 `result` 文本 + `usage`」的版本，返回 `(text, "stop")`。**只依赖 `base_ai_handler` 的稳定契约，
  不受版本守卫限制**（区别于其它依赖内部实现的补丁，放在版本守卫之前）。子进程调用逻辑抽在 `cli/install.py`
  的 `run_cli_chat`，`_install_cli_chat_completion`（服务 pr-agent 工具 run）与编排 chat 通道共用它。
- **编排 chat 通道 CLI 短路**：上一条服务的是 **pr-agent 工具 run**（`/describe` `/review` `/ask` 经 `pr_agent.cli`，
  必经 `chat_completion`）。**编排自有步骤**（路由 / judge / summary 经 `meebox_pragent_shim.chat`）则在 CLI 模式
  **直接调 `run_cli_chat`、不 import pr_agent / litellm**——CLI 路径本就不用 litellm，无谓地拉起整套 pr_agent +
  litellm import 会给每次 chat 子进程白增数百 ms~1s+ 启动开销，而编排一个流程要调多次。API 模式无此短路（litellm
  即 HTTP 客户端、不可绕），仍复用被补丁的 `LiteLLMAIHandler` 以继承 provider 路由 / 去 temperature / 提示缓存 /
  usage 哨兵。
- **prompt 走 stdin**：review prompt 含完整 diff（数十 KB），走 argv 会撞命令行长度上限；system/user 合并成
  一段喂入（CLI 无独立 system 槽）。cwd 默认落到中性临时目录，避免吃到被评审仓库的 `CLAUDE.md`/`AGENTS.md`。
- **`/ask` 例外（取完整文件上下文）**：自由问答需读真实文件，仅对 `/ask` 由主进程下发 env `MEEBOX_CLI_WORKDIR`
  = 物化好的 worktree，shim 据此把子进程 cwd 落到 worktree（`describe`/`review` 不下发、维持中性临时目录）。
  落 cwd 前主进程先**清空该 worktree 内仓库自带的 agent 指令文件**（`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor`
  规则 / `.github/copilot-instructions.md`，见 `services/pr-agent/worktree-sanitize.ts`）——worktree 即 PR HEAD、
  作者可控，不清空则 CLI 会自动加载这些指令、被评审 PR 可经此注入 / 污染回答；worktree 用后即弃，就地清空无副作用。
- **沿用 CLI 自身登录态**：子进程继承 `HOME`/`USERPROFILE`，CLI 读自己的登录凭据（如 `~/.claude`）运行。
  为避免本机环境里残留的 API key 串入、覆盖 CLI 自身的登录方式，shim 显式从子进程 env **剥掉
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`**。使用的模型、额度与合规均由该 CLI 的账户与用户授权决定。
- **代理自动透传**：子进程 env 由 `os.environ` 拷贝而来（仅剔除上面两个 API key），`HTTP(S)_PROXY` / `NO_PROXY`
  原样保留 → `claude` 出站自动走用户配置的代理（见 [09](09-networking-proxy.md)），无需另设。
- **token usage**：从 claude JSON 的 `usage` 构造同款 `@@MEEBOX_USAGE@@` 哨兵，主进程同一套累加。↑输入总量取
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（模型实际处理的全部输入侧）；其中
  `cache_read_input_tokens`（命中量）**单列上抛**供 UI 拆分展示，顶层 `num_turns`（agentic 轮次）一并上抛。详见
  下「CLI 模式的 token 计量与提示缓存」。
- **一期边界**：仅 `claude`（UI 校验拦下 codex 等，命令框可输入留待后续）；并发为「一次调用一个子进程」；父进程被
  超时 SIGKILL 时子 `claude` 可能短暂遗留（孤儿），后续可补 kill 传播。

### CLI 模式的 token 计量与提示缓存

CLI（claude / codex）模式下运行卡片的 token 数常远超模型单请求上下文窗口（如 `/ask` 出现 ↑数百万），这**不是超限、也不是计量
错误**，而是 agentic 多轮 + 提示缓存的自然结果。要点：

- **累计语义**：`claude -p` 是 agentic headless，一次 run 内部会有多个模型轮次（`num_turns`）。顶层 `usage` 是**该会话所有轮次
  的累加**，每轮都把不断增长的对话 / 工具结果重新送进模型，故 token 随轮次叠加。单轮从不超窗口（CLI 自身做上下文压缩），累计值
  膨胀属正常。UI 据 `num_turns` 展示轮次（单轮不显示），帮助理解「这是 N 轮的总量、非单请求规模」。
- **`cache_read` vs `cache_creation`（命中 ≠ 写入）**：Anthropic 提示缓存把输入分三段——`input_tokens`（新内容）、
  `cache_creation_input_tokens`（**写入**缓存，计费 1.25×/2×）、`cache_read_input_tokens`（**读取命中**，计费 0.1×）。UI 的
  「缓存命中量（⛁）」**只取 `cache_read`**，写入不计作命中。多轮里每轮都重读已缓存前缀，`cache_read` 跨轮累加，故对多轮 run 常
  呈现「缓存命中量 ≈ 输入总量」（绝大部分输入都是缓存读）。**codex 走 OpenAI 约定**：`input_tokens` 本身**已含**缓存、命中量字段名为
  `cached_input_tokens`，故采集层（`cli/install.py`）两种字段名都识别——Anthropic 的 `cache_read_input_tokens` 需累加进总量、
  codex 的 `cached_input_tokens` 仅作命中量不再计入总量。
- **缓存暖化与任务顺序**：claude CLI 自身在缓存 TTL（5min / 1h）内对相同前缀做服务端缓存（基础 system prompt、工具定义，乃至相同
  的 diff 段）。**先跑过 `describe` 会暖好缓存**，随后对同 PR 的 `review` 多为 `cache_read` 命中、真正新增输入很小 → 表现为「输入
  很少、几乎全是缓存读」。这是顺序执行带来的正常优化，不是统计异常。
- **并行启动对缓存命中的影响**：run 队列（`services/pr-agent/run-queue.ts` 的 `pump()`）在并发未达上限时同步连续起跑，故同 PR 的
  describe / review / improve 几乎同时启动（~100ms 间隔）。Anthropic 缓存条目要等**首个请求写完**才可被后续读，并行启动时后发
  请求读不到尚未落地的缓存 → 共享前缀各自 miss + 各自写、命中率下降。但**影响有限**：受影响的只是跨 run 的小共享前缀（基础 system
  ~20–30k，通常已被其它 claude 活动暖好），而大额 `cache_read` 来自**单 run 内部的多轮重读**、与并行无关。故一般**不值得**为缓存复用
  而串行化同 PR 任务；若确要最大化跨 run 复用，可考虑「describe 先行、完成后再放行其余」的轻量调度（收益有限，未实现）。
- **litellm 路径与跨模型缓存适配**：API 模式下显式 `cache_control` 标记**仅 Anthropic 系生效**（原生 / Bedrock / Vertex Claude）。
  `_apply_system_prompt_cache`（`patches/litellm_handler.py`）对 Anthropic 标 1h TTL 缓存，覆盖两类调用：①**编排 chat 通道**
  （`MEEBOX_CHAT_CACHE` 置位、system 含 `CACHE_BREAK`）按断点缓存全局稳定前缀；②**pr-agent 工具 run**（`/review` `/describe`
  `/improve` `/ask`，无 `CACHE_BREAK`）整段缓存 system——pr-agent 的指令 + 输出格式约 12k 字符、仅随配置/语言/规则变、跨 PR 稳定
  （可变的 diff 在 user 侧不进缓存），故同配置下跨运行 1h 内命中。OpenAI / DeepSeek 走**自动前缀缓存**（无需标记，把稳定内容放前缀
  即可命中，shim 对非 Anthropic 自动剥除标记拼回纯文本）；openai-compatible（DashScope / 火山 / vLLM）能否命中取决于后端，
  `cache_control` 一律被忽略。两条路径（CLI / API）都采集 `cache_read`（API 取 Anthropic `cache_read_input_tokens` 或 OpenAI
  `prompt_tokens_details.cached_tokens`），UI 展示一致。

### 注入 env

每次 run 给子进程注入：LLM provider 凭据（`OPENAI__KEY` / `DEEPSEEK__KEY` / `ANTHROPIC__KEY` 等，按 provider 分族；
cli 模式不下发任何密钥，只给 `MEEBOX_CLI_MODE` / `MEEBOX_CLI_BIN` 两个哨兵）+
模型名 + 响应语言 + 命中规则的 `EXTRA_INSTRUCTIONS`（见 [07](07-rules.md)）+ 出站代理（见 [09](09-networking-proxy.md)）。

## 数据 / 接口契约

- **策略**：`'auto' | 'embedded' | 'local-cli'`（配置 `pr_agent.strategy`）。
- **run 选项**：`prUrl` / `tool('describe'|'review'|'ask')` / `cwd`(worktree) / `targetBranch` / `env` / `extraArgs` /
  `onLine`(stdout/stderr 实时回调) / `signal`(取消)。
- **运行时 manifest**：pin 的 python 主次版本 + pr-agent 版本（升级时与 shim 的 `_EXPECTED_PRAGENT_VERSION` 同步）。
- **shim 调试**：`MEEBOX_SHIM_DEBUG=1` → shim 打 stderr 诊断。

## 扩展与注意事项

- **升级 pr-agent**：改 manifest 版本 → 同步 shim 的 `_EXPECTED_PRAGENT_VERSION` → 重新验证各补丁（构建期会强校验
  两处一致，漏同步直接 fail；运行期不符则降级 + WARNING）。
- **改了 shim**：跑一次 `prepare:pragent` 即重新同步进 vendor（幂等跳过分支也会同步 shim），无需 `--force` 全量重建。
- **流式模型丢 usage**：个别需强制流式的模型用 MockResponse、无 usage，token 采集对它们缺失（非流式不受影响）。
- **启动开销**：嵌入式本地进程下当前无明显瓶颈。若大 PR 再现问题，可裁剪 pr-agent 内部预处理（env 开关）。
- **平台范围**：嵌入式运行时初版只出 Windows x64 + macOS arm64（见 [打包与发布](../development/packaging-release.md)）。
