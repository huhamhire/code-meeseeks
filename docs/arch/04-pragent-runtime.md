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
关掉 litellm 的远端价格表联网（弱网会 SSL 超时）。

### 本地 CLI provider

让用户**不填 API key、改用本机已装且已登录的 agentic CLI**（一期仅 **Claude Code**）跑评审。LLM Profile 里
新增 `provider='cli'`，`model` 字段填命令名（`claude`）。其余 provider 走 litellm 直连 API，cli 模式则**完全绕过
litellm**。

- **接入点**：env `MEEBOX_CLI_MODE=1` + `MEEBOX_CLI_BIN=claude`（由 `buildPragentEnv` 注入）→ shim 把
  `LiteLLMAIHandler.chat_completion` 整体换成「起 `claude -p --output-format json` 子进程、prompt 走 stdin、
  解析 JSON 的 `result` 文本 + `usage`」的版本，返回 `(text, "stop")`。**只依赖 `base_ai_handler` 的稳定契约，
  不受版本守卫限制**（区别于其它依赖内部实现的补丁，放在版本守卫之前）。
- **prompt 走 stdin**：review prompt 含完整 diff（数十 KB），走 argv 会撞命令行长度上限；system/user 合并成
  一段喂入（CLI 无独立 system 槽）。cwd 落到临时目录，避免吃到被评审仓库的 `CLAUDE.md`。
- **沿用 CLI 自身登录态**：子进程继承 `HOME`/`USERPROFILE`，CLI 读自己的登录凭据（如 `~/.claude`）运行。
  为避免本机环境里残留的 API key 串入、覆盖 CLI 自身的登录方式，shim 显式从子进程 env **剥掉
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`**。使用的模型、额度与合规均由该 CLI 的账户与用户授权决定。
- **代理自动透传**：子进程 env 由 `os.environ` 拷贝而来（仅剔除上面两个 API key），`HTTP(S)_PROXY` / `NO_PROXY`
  原样保留 → `claude` 出站自动走用户配置的代理（见 [09](09-networking-proxy.md)），无需另设。
- **token usage**：从 claude JSON 的 `usage`（`input_tokens`(+cache_*) ≈ prompt，`output_tokens` ≈ completion）
  构造同款 `@@MEEBOX_USAGE@@` 哨兵，主进程同一套累加。
- **一期边界**：仅 `claude`（UI 校验拦下 codex 等，命令框可输入留待后续）；并发为「一次调用一个子进程」；父进程被
  超时 SIGKILL 时子 `claude` 可能短暂遗留（孤儿），后续可补 kill 传播。

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
