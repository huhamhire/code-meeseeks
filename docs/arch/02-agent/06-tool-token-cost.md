# pr-agent 工具 token 成本与优化

## 职责与边界

聚焦 pr-agent 各工具（`/describe` `/review` `/improve` `/ask`）一次调用的 **token 成本模型**：成本从何而来、
哪个工具在什么模式下会显著放量、以何种手段收敛。运行时机制（调用桥 / 嵌入式 Python / monkeypatch /
token 采集）见 [pr-agent 集成与运行时](05-pragent-runtime.md)；worktree 物化见 [仓库镜像](../01-platform/02-repo-mirror.md)。

结论先行：**成本放量集中在 CLI 提供方（本机 agentic CLI，如 claude / codex）下的 `/ask`**——它把 agentic CLI
投进整棵 worktree、仅给一句问题、任其多轮探索文件，token 随轮次叠加、无上限。其余工具（含 API 提供方下的
`/ask`）都是单轮、有界的。

## 各工具的 token 模型

| 工具 | 上下文来源 | 轮次 | 成本特征 |
|------|-----------|------|---------|
| `/describe` `/review` `/improve` | pr-agent 预算内的 PR diff（`CONFIG__MAX_MODEL_TOKENS` 上限） | 单轮 | 有界、可预期 |
| `/ask`（**API 提供方**，litellm） | `pr_questions` 模板：PR 元信息 + 完整 diff（同样受 max_model_tokens 约束） | 单轮 | 有界、与 review 同量级 |
| `/ask`（**CLI 提供方**，agentic CLI） | **仅问题文本**；其余靠 CLI 在 worktree 里读文件现探 | **多轮**（`num_turns` 可达 3–10+） | **无界**、随探索深度叠加 |

关键代码位（差异所在）：

- [run-executor.ts](../../../apps/desktop/src/main/services/pr-agent/run-executor.ts) `buildInvocation`：仅当 `tool === 'ask' && provider === 'cli'` 时下发
  `env['MEEBOX_CLI_WORKDIR'] = wtPath`，把子进程 cwd 落到 worktree（describe/review/improve 维持中性临时目录、
  只见预置 diff、读不到仓库文件）。
- [cli/install.py](../../../apps/desktop/scripts/pragent-shim/meebox_pragent_shim/cli/install.py) `run_cli_chat`：以 `cwd = MEEBOX_CLI_WORKDIR` 起
  agentic CLI 子进程；无 system 槽、prompt 走 stdin；回读 `num_turns` 经哨兵上抛。
- [usage.ts](../../../apps/desktop/src/main/services/pr-agent/usage.ts)：累加 `turns`（CLI agentic 各轮的 `num_turns`），驱动结果卡的「轮次」chip。

## 成本驱动（按影响排序）

1. **CLI 提供方 `/ask` 的冷启动 agentic 探索（主因）**：CLI 拿到的只有问题，PR 改了什么、代码在哪都得靠自己
   `git`/读文件发现。发现类轮次占大头，且每轮把不断增长的对话 + 工具结果重新送模型，token 近似随轮次平方增长。
2. **无轮次上限**：主进程未向 CLI 传任何 `max-turns`，何时收手由 CLI 自行判断，复杂问题 / 大仓易触发长尾轮次。
3. **无前置上下文**：与 API 模式「预置有界 diff」相反，CLI 模式零预置，全靠现探——这是 (1) 的直接成因。
4. **累计上下文重传**：agentic 模式固有，每轮携带完整历史，非线性叠加（无法消除、只能通过压缩轮次/上下文来抑制）。

> 说明：单 commit 范围（见 [pr-agent 运行时](05-pragent-runtime.md) 与提交范围联动）收窄的是 **diff 定界**，
> 惠及 review/describe/improve；对 CLI 模式 `/ask` 的**文件探索面**约束有限（worktree 文件系统仍是整仓）。

## 优化路线

### #1 前置上下文注入（已实现）

对 CLI 提供方的 `/ask`，在问题文本前置注入**有界的 PR（或所选 commit）变更摘要**：变更文件清单 + 统一 diff
（按字符预算截断，超限附省略提示）。让 CLI「开局即知改了什么、在哪」，省掉大量发现类轮次；仍可按需深读具体
文件，但从有向探索起步而非从零翻找。

- 注入点：`buildInvocation` 组装 `askQuestion` 时，对 cli 模式在 `req.question` 前拼入变更摘要段。
- diff 来源：worktree 的 `git diff <base>...<head>`（复用镜像的三点 diff 口径；单 commit 范围下即 `parent...sha`）。
- 有界：变更文件清单始终注入（体量小、定向价值高）；统一 diff 受字符预算约束，超限截断并标注（避免把成本
  从「多轮探索」平移成「一次性巨 prompt」）。API 提供方不受影响（其 diff 由 pr-agent 模板预置）。

### #2 轮次 / 工具预算上限（计划）

为 CLI 提供方 `/ask` 设 agentic 轮次上限，直接封顶最坏情形。

- **配置**：`agent.strategy` 增 `ask_max_turns`（整数，默认 6–8；`0` = 不限）。落 [config.ts](../../../packages/shared/src/config.ts) zod schema，设置页评审策略分区加下拉。
- **下发**：`buildInvocation` 仅对 cli 模式 `/ask` 设 `env['MEEBOX_CLI_MAX_TURNS'] = String(n)`（0 时不下发）。
- **shim 消费**：`run_cli_chat` 读该 env，按命令规格插入轮次上限 flag（与 `low_effort_flags` 同法插到尾部 `-` 之前）：
  - **claude**：`--max-turns <n>`（`-p` headless agentic 直接支持）。
  - **codex**：`exec` 无对等的轮次上限 flag；现有 `--sandbox read-only` + 关 web/image 工具已收敛工具面，
    轮次约束待其 CLI 暴露相应能力后补齐（当前 codex 通道以 `ask_max_turns` 无效对待、记 debug 日志）。
- **权衡**：触顶时 CLI 返回部分结果——需在结果卡给出「因轮次上限提前收尾」的提示，避免误读为完整回答。
  故默认值取「够用不误伤」的中档，并保留 `0` 关闭逃生口。

### 检索增强（codegraph / RAG，评估后暂缓）

将「盲目探索」替换为「定向检索」，收敛 (1)：

- **codegraph 作为 CLI 的检索工具（MCP）**：对**大仓**确有价值——「符号定义在哪 / 谁调用了它」一次查询即得，
  替代多次整文件读。但成本不低：worktree 每次物化即临时，需每次建图或改为对长驻镜像增量维护并保鲜；且要把
  MCP server 接进 headless CLI 调用。它压的是「过度读取」，轮次与累计上下文仍在——是 #1/#2 之上的乘数，非替代。
- **RAG / 向量检索**：本质是「#1 的智能版」——向量选相关片段后注入。收益与前置 diff 注入同向，但additional
  引入嵌入索引与保鲜成本，基础设施更重。仅在「大仓 + 高频 ask」且 #1/#2 仍不够时才划算。

**结论**：先落 #1 + #2（无新基础设施，把 O(轮次²) 收敛为有界、近线性），大仓 ask 仍偏贵时再评估
codegraph-as-MCP。RAG 更重，暂不排期。

## 关联

- [pr-agent 集成与运行时](05-pragent-runtime.md)：调用桥 / 嵌入式运行时 / monkeypatch / token 采集 / env 注入。
- [仓库镜像](../01-platform/02-repo-mirror.md)：worktree 物化与三点 diff 口径。
- [评审闭环](../01-platform/03-review-workflow.md)：输出解析、findings、草稿。
