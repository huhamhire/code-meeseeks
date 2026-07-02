# 工具 token 成本与上下文分层

## 职责与边界

聚焦 pr-agent 各工具（`/describe` `/review` `/improve` `/ask`）与自由对话 Agent 的**上下文来源与 token
成本模型**：上下文分几层、成本在哪一层放量、以何种手段收敛而不牺牲评审深度。运行时机制（调用桥 / 嵌入式
Python / monkeypatch / token 采集）见 [pr-agent 集成与运行时](05-pragent-runtime.md)；会话 Agent 化与规划循环见
[会话 Agent 化](02-session.md)；worktree 物化见 [仓库镜像](../01-platform/02-repo-mirror.md)。

结论先行：成本放量集中在「本机 agentic CLI 提供方下的 `/ask`」与「自由对话 Agent 的规划循环」——前者一次
探索可跨多轮读文件，后者可连发多次这样的 `/ask`。**不存在「diff-only 的盲评审」**：pr-agent 默认已把变更的
近端上下文（所在函数 / 类、周边行、整份新文件、best-practices）注入 prompt。

## 三层上下文模型

评审上下文并非「diff vs 全仓」二选一，而是三层递进：

| 层 | 上下文 | 成本 | 本仓何处使用 |
|----|--------|------|-------------|
| 1 · 裸 diff | 仅 `+/-` 行 | 极低 | 无（不单独使用） |
| 2 · **展开 diff（pr-agent 默认）** | diff + 动态上下文补到**所在函数 / 类** + hunk 周边行 + 整份新文件 + best-practices | **有界、确定**（受 `MAX_MODEL_TOKENS` 约束） | `/review` `/describe` `/improve`，以及 `/ask` 的基座 |
| 3 · agentic 探索 | 按需读任意文件、跟调用链、跨文件核对 | **无界**（轮次 × 累计上下文，近平方增长） | 仅 `/ask` + CLI 提供方（下发 worktree cwd）；自由对话 Agent 可跨步多次触发 |

第 2 层是 pr-agent 对「裸 diff 不足以评审」的既定答案：以确定成本纳入变更的近端爆炸半径，而非放 agent 自由
探索。pr-agent 默认即开（[configuration.toml](../../../apps/desktop/vendor/pragent/python/Lib/site-packages/pr_agent/settings/configuration.toml)：
`allow_dynamic_context=true`、`patch_extra_lines_before=5`/`_after=1`、`max_extra_lines_before_dynamic_context=10`、
`best_practices` 等），本应用未覆盖这些默认，故 `/review` 天然享有第 2 层上下文——缺的是**远端**上下文（别处
文件的调用方、跨模块契约、数个文件外的不变量）。

第 3 层只在 CLI-`/ask`：`buildInvocation` 仅当 `tool==='ask' && provider==='cli'` 时下发 `MEEBOX_CLI_WORKDIR`，让
agentic CLI 在 worktree 里读文件、多轮迭代。此时 CLI **仍先拿到 pr-agent 渲染的展开 diff**（见 pr_questions 模板
的 `The PR Git Diff`）——它不是「只有问题、从零翻找」，而是「已有第 2 层、再探第 3 层」。

## 成本驱动

- **CLI-`/ask` 的 agentic 探索（第 3 层）**：worktree 可读、无轮次上限，倾向整文件通读 / 全仓扫描；每轮携带
  不断增长的对话 + 工具结果重传，近平方增长。CLI 模式下 `MAX_MODEL_TOKENS` 被忽略（CLI 自管上下文窗口），
  无应用侧输入上限。
- **自由对话 Agent 的规划循环**：仅受「Agent 最大步数」`max_steps`（默认 8）约束，可跨多步连发 `/ask`，每次都是
  一次第 3 层探索——若不另加约束，成本随步数叠加而失控。

第 2 层（含 API 提供方的 `/ask`、所有 review/describe/improve）是单轮、受 token 预算硬约束的确定成本。

## 优化措施

目标：让第 2 层足够充分（廉价、确定），让第 3 层的**必要**探索更高效、**数量**受控——而非砍掉探索降级评审。

### 已实现

- **CLI-`/ask` 只读代码检索指引**：`buildExtraInstructions` 的 `worktreeRetrievalDirective`（仅 CLI 提供方注入）
  引导以 diff 为改动真源、**定向搜符号 · 只读所需行段**替代整文件通读与全仓扫描，够用即止。刻意只用**只读**
  工具集——headless（无 TTY）下 claude default 权限模式对内置只读工具（Read/Grep、以及 `grep`·`git log/show`
  等只读 Bash 命令）静默放行、无授权摩擦，但对非只读工具（写、以及 `rg` 等不在内置只读白名单的命令）不是
  拒绝而是**直接中止会话**，故明确「用 `grep` 不用 `rg`」、禁止改动类命令。只依赖「内置只读工具静默放行」这一
  跨版本稳定语义，不加 `--allowedTools`/`--permission-mode` 等依赖具体 claude 版本的启动参数。
- **自由对话 Agent 的 `/ask` 预算**：规划循环按配置「追问数量」`max_followup_asks` 对本会话 `/ask` 计数封顶，
  达上限即在红线校验处拒绝新的 `/ask` 并回喂（促模型据现有上下文收尾或改用只读工具）；`describe/review/improve`
  不受此约束、`max_steps` 不变。**count-only**：始终按配置的追问数量生效，与「自动追问」开关无关（开关仅约束
  评审微流程的条件追问）。评审微流程侧的条件追问（judge 步）与本预算共用同一配置值。

### 已否决

- **给 CLI-`/ask` 前置注入统一 diff**：CLI-`/ask` 的 prompt 已由 pr_questions 模板携带 pr-agent 的展开 diff（第 2
  层），再注入一份只是重复上下文、徒增 prompt，且不减少第 3 层探索（探索是为拿 diff 之外的远端上下文）。

### 待评估（暂缓）

- **codegraph 作为检索工具**：把「盲读」换成「定向查（定义 / 调用方 / 影响面）」，收敛第 3 层浪费。**仅适用于
  有工具循环的 agentic 路径（`/ask`）**：作为 MCP server 挂给 headless CLI。`/review` 是单轮工具、无工具循环，
  codegraph 对它只能是 **orchestrator 侧预注入**（组 prompt 时选取远端上下文拼进第 2 层），而非「传给 review 的
  工具」。成本：worktree 每次物化即临时，需每次建图或改对长驻镜像增量维护并保鲜；claude 支持 MCP、codex 不支持
  外部 MCP 注入。宜在既有措施仍不足时再上。
- **单次 `/ask` 的 agentic 轮次上限**（claude `--max-turns`）：作安全兜底、非成本主手段；依赖具体 CLI 版本对该
  旗标的支持，暂不引入。

## 关联

- [pr-agent 集成与运行时](05-pragent-runtime.md)：调用桥 / 嵌入式运行时 / monkeypatch / token 采集 / env 注入。
- [会话 Agent 化](02-session.md)：规划循环（ReAct）、步数上限、过程留存。
- [仓库镜像](../01-platform/02-repo-mirror.md)：worktree 物化与三点 diff 口径。
