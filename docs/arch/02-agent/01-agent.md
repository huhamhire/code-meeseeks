# Agent 与上下文

## 职责与边界

Agent 是「对话即委派」与「自动预评审」共同的底座：一套可被规则约束、读取本地分层上下文、自主编排 pr-agent 工具的运行时。本篇讲 **Agent 的身份与上下文**——目录分层、上下文注入、工具红线、会话隔离、提示词模版；两类用法各成一篇：

- **会话 Agent 化**（交互式自然语言 → 委派）见 [会话 Agent 化](02-session.md)。
- **AutoPilot 自动预评审**（轮询触发、跨 PR 调度）见 [AutoPilot 与调度](03-autopilot.md)。

负责：Agent 上下文目录（灵魂 / 规范 / 记忆 / 用户画像 / 规则）的加载与注入、工具目录与修改性操作的授权红线、会话隔离与可写记忆的并发、提示词模版与初始化。

不负责：自然语言路由与规划循环（见 [会话 Agent 化](02-session.md)）、AutoPilot 候选筛选与调度（见 [AutoPilot 与调度](03-autopilot.md)）、pr-agent 进程本身与 token 采集（见 [pr-agent 运行时](05-pragent-runtime.md)）、findings 解析与草稿发布（见 [评审闭环](../01-platform/03-review-workflow.md)）、规则匹配的正则语义（见 [规则](04-rules.md)；本模块只承载规则正文的存储位置 `<agent.dir>/rules/`）、PR 发现 / 软删 / 索引（见 [状态存储](../99-core/01-state-storage.md)）、平台写操作 API（见 [平台适配](../01-platform/01-adapter.md)）。

> 与 [规则系统](04-rules.md) 的关系：规则正文存于 Agent 目录的 `rules/` 子目录（`<agent.dir>/rules/`）；其「一文件一规则 + frontmatter 匹配 + 取全部命中（封顶 N 条）按 Ruleset 分段拼接 + per-tool 注入 `EXTRA_INSTRUCTIONS`」的匹配语义由 [规则](04-rules.md) 定义，本模块只负责加载与注入。

## 核心设计

### Agent 目录：分层上下文

Agent 目录是 Agent 的**完整人格与知识来源**，挂载于配置 `agent.dir`（路径，空 = 回落默认位置 `~/.code-meeseeks/agent`）；**无独立启用开关**——配了 LLM 且 pr-agent 就绪即可用。与应用数据解耦，可指向独立目录或团队 git repo。

目录约定（缺任一文件不阻断，缺则该层上下文为空）：

```
<agent.dir>/
├── SOUL.md      # 灵魂：核心职责、工作边界、语气基调（Agent 只读·默认由预制模版规定）
├── AGENTS.md    # 工作规范：评审流程、AutoPilot 触发策略、工具使用红线（人写）
├── MEMORY.md    # 长期记忆：跨 PR / 跨会话的事实沉淀（Agent 可追加，人可编辑）
├── USER.md      # 用户画像：评审偏好与个人习惯（Agent 可追加，人可编辑）
└── rules/       # 规则化注入：「一文件一规则 + frontmatter」（人写，见 04-rules）
    └── *.md
```

关键取舍：

- **分层而非单文件**：`SOUL` 定职责边界（恒定）、`AGENTS` 定流程与红线（恒定）、`rules/` 定逐 PR
  命中的细则（结构化、可正则匹配）、`MEMORY` / `USER` 是**可写记忆**（Agent 在工作中沉淀、人可校订）。
- **`SOUL.md` 对 Agent 只读**：灵魂是 Agent 自身无权改写的「宪法」——**禁止 Agent 修改 `SOUL.md`**，
  默认情况下其内容**完全由预制模版规定**（初始化时落地，见下「提示词模版与资源目录」）。约束在运行时强制：装配上下文时
  `SOUL.md` 只读注入，Agent 工具目录里没有写 `SOUL.md` 的能力；即便 LLM
  越权产出对它的写操作也被拒（与下「工具规范」修改类红线同源）。这样 Agent 无法自我重定义职责与边界。
  仅人（或团队 git repo 的维护者）可改 `SOUL.md`。
- **读写边界清晰**：`SOUL` 仅人可改（Agent 只读）；`AGENTS` / `rules/` 人写为主；`MEMORY` / `USER`
  是 Agent 与人共写的可写记忆。
- **整目录团队共享**：与 [规则](04-rules.md) 同理——把 `agent.dir` 指向一个 git repo，团队 clone
  即同一套灵魂 / 规范 / 规则。`MEMORY` / `USER` 虽可写，但仍属共享上下文（跨 PR 生效），
  写入走原子写（见下「会话隔离」）。
- **空目录 = 退化为原生**：`agent.dir` 为空（未配置 Agent 目录）时，Agent 运行时降级——
  自然语言回退到等价 `/ask`、AutoPilot 不可用、pr-agent 走原生行为。保证「不配置也能用」。

### 上下文注入：每次执行装配最新内容

**每次 Agent 执行都现读、现装配，无缓存**（与 [规则](04-rules.md)「每次 run 现读规则」一致），
确保用户刚改完 `SOUL.md` / 新写一条 MEMORY 立即生效。Agent 目录是寥寥几个小 Markdown，
现读开销在毫秒级、相对一次数秒的 LLM 调用可忽略；且天然 stale-proof——`agent.dir` 常指向团队 git
repo，外部 `git pull` 在应用之外发生，现读总能拿到最新。故**不引入内存缓存 /
文件监听作为加载权威**：监听器（跨平台可靠性坑、自写 `MEMORY/USER` 反触发回环）的收益主要是 UI
反应性而非 run 路径性能，可作为后续旁路信号（通知渲染层刷新「当前命中规则」chip），
但绝不让正确性依赖它。

一次装配的系统上下文按固定次序拼接：

1. `SOUL.md` 正文 —— 人格与边界。
2. `AGENTS.md` 正文 —— 工作规范与红线。
3. **工具目录（tool catalog）** —— 环境内预定义的工具指令（`/describe`·`/review`·`/ask` 等）的名称、
   语义、参数与**可用性标记**（读类 / 修改类），由运行时**注入**而非写死在提示词里。
   新增工具只需在目录登记即对 Agent 可见。
4. 命中的 `rules/` 规则正文 —— 按当前 PR 上下文 `{projectKey, repoSlug, targetBranch, tool}`
   匹配取首条（见 [规则](04-rules.md)）。
5. `MEMORY.md` + `USER.md` 正文 —— 长期记忆与用户画像。
6. **当前 PR 元数据** —— 标题 / 描述 / 目标分支 / 变更概况。
7. **当前会话快照** —— 本 PR 的 todo 与进度（见 [会话 Agent 化](02-session.md)），让 Agent 续上未完成的规划。
8. **语言行为指令** —— 执行时注入的显式国际化规则，覆盖两类语言行为：
   - **AI 输出语言**：Agent / 评审产物用目标语言输出，跟随 `config.language` /
     `resolveLanguage`（沿用既有「AI 回复语言随界面语言」，见 [pr-agent 运行时](05-pragent-runtime.md)
     的响应语言注入、[i18n](../03-gui/04-i18n.md)）。
   - **记忆写入语言**：Agent 向 `MEMORY.md` / `USER.md` **追加新记忆时用用户习惯语言记录**（默认取
     `config.language`，可由 `USER.md` 已记录的语言偏好细化），便于用户日后阅读自己的记忆。
     这条写入行为规则**必须显式写进提示词**——否则 Agent 可能按模版的 en-US 或随机语言落记忆。

**三个语言概念解耦**（三者独立）：

1. **模版 / 上下文文件写成什么语言**：en-US 单份、用户可改写（见下「提示词模版与资源目录」）。
2. **AI 输出语言**：跟随 `config.language`。
3. **记忆写入语言**：用户习惯语言。

`SOUL.md` 可以是英文，输出与新记忆仍按用户语言走中文；反之亦然——由第 8 项这组执行时规则
单点控制输出与写入两类行为。

工具目录的「可用性标记」是红线落地的关键（见下「工具规范」）：修改类工具在未授权时以**禁用态**注入，
Agent 知其存在但不可调用。

### 工具规范：修改性操作红线

工具目录按副作用分两类，运行时**硬性**区别对待（不只靠提示词约束）：

- **读 / 分析类**（`/describe`·`/review`·`/ask`、读 diff、读 findings、读 PR 列表等）：Agent
  始终可自主调用。注意 `/describe`·`/review` 本身只产出本地草稿、不写远端，属安全操作。
- **修改类**（`/approve`、`/needswork`、发布 inline 评论、reply/edit/delete、合并 PR
  等一切对远端有副作用的写）：**默认禁止 Agent 自主调用**。仅在两种授权下放行：
  1. **用户直接下达指令**（在会话里显式要求执行该操作）；
  2. **规则显式授权**（`AGENTS.md` / `rules/` 中明确授予 AutoPilot 某项写权限，见 [AutoPilot 与调度](03-autopilot.md) 的「写权限扩展」）。

红线在运行时层强制：修改类工具在无授权时以**禁用态**注入工具目录，且执行入口二次校验授权标志——即便
LLM「越权」产出一个 `/approve` 调用，运行时也拒绝并记入 transcript。这样「提示词被绕过」
不等于「操作被执行」。

**工具清单单一真相源**：所有工具（id / 命令名 / 读改分类 / grant / 是否运行队列工具）集中声明在共享层的
**统一注册表 `TOOLS`（tool-registry）**；运行工具枚举 `ReviewRunTool`、工具目录 `buildToolCatalog`、规划红线
允许集均由它派生——新增 / 调整工具只改注册表一处。

### 会话隔离与规则共享

- **规则 / 上下文共享**：`agent.dir`（SOUL / AGENTS / MEMORY / USER / rules）是**全局单份**，所有
  PR 的 Agent 会话读同一套。改一处，处处生效。
- **会话隔离**：每个 PR 的 Agent 会话状态（todo、进度、plan、transcript）**按 PR 隔离**，落在该 PR
  的 per-PR 目录下（见 [状态存储](../99-core/01-state-storage.md) 的 `state/prs/<hash>/`），互不串扰。不同 PR 并发跑
  Agent 安全。
- **可写记忆的并发**：`MEMORY.md` / `USER.md` 是跨 PR 共享的可写文件，多个会话可能同时追加 → 走
  StateStore 同款**原子写（tmp → fsync → rename）**、Main 进程单写者串行化；
  追加语义优先（不整文件覆盖），降低并发互覆风险。

### 提示词模版与资源目录

- **工程内预建模版**：仓库内置一套默认 `SOUL.md` / `AGENTS.md` / `MEMORY.md` / `USER.md` 与示例
  `rules/`，作为 Agent 目录的**初始化骨架**。
- **模版统一 en-US 单份、不做 i18n**：模版是用户的**著作内容**而非产品 UI，故不提供多语变体——一律以
  **en-US** 落地（与项目 en-US 兜底一致）。用户初始化后可自由改写成目标语言（中文 / 日文 …）；
  改的是自己的上下文文件，与 AI 输出语言互不绑定（输出语言由上「上下文注入」第 8 项的执行时国际化规则单点控制）。
- **统一资源目录管理**：模版集中放在桌面应用的**单一资源目录**下，
  随应用打包（与嵌入式运行时等资源同级管理），由初始化逻辑按清单拷贝；不散落在各处。
- **初始化时机**：用户首次启用 Agent（指定空的 `agent.dir`、或首启向导引导）时，从模版目录 scaffold
  出上述文件；已存在则不覆盖（幂等）。`AGENTS.md` / `MEMORY.md` / `USER.md` / `rules/` 是可编辑
  Markdown，用户与 Agent 后续按各自权限改写。
- **`SOUL.md` 默认由模版规定**：灵魂的内容**默认完全来自预制模版**（初始化落地的就是模版正文），
  Agent 全程无权改写（见上「Agent 目录」）。这把「Agent 是谁、边界在哪」的定义权牢牢留在模版 / 维护者侧；
  个人或团队若要定制，仍由人去改 `agent.dir` 里的 `SOUL.md`（或在团队 git repo 中统一维护），
  而非交给 Agent 自演化。

## 数据 / 接口契约

**配置（`agent.*` 命名空间）**：完整字段与默认值见 [配置与凭据](../99-core/02-config-and-secrets.md) 的配置形状，本篇只点设计要点：

- **无独立启用开关**：配了 LLM 且 pr-agent 就绪即可用；`agent.dir` 空 = 回落默认位置（非停用）。
- `strategy.max_followup_asks`（条件性 `/ask` 硬上限）归 `strategy` 而非 `autopilot`——手动自动评审与 AutoPilot 共用同一微流程（见 [会话 Agent 化](02-session.md)、[AutoPilot 与调度](03-autopilot.md)）。
- `autopilot.grants` 为逐项写权限授权（默认全空 = 全拒）。

**Agent 目录文件清单**：`SOUL.md` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `rules/*.md`（rules 的
frontmatter schema 见 [规则](04-rules.md)）。

**`ToolCatalogEntry`**：`name` / `semantics` / `params` / `mutating`(bool) / `enabled`(按授权)——工具目录注入用，红线据 `mutating` + `enabled` 落地。

## 扩展与注意事项

- **红线是硬约束、非软提示**：修改类工具的授权校验必须落在运行时执行入口，不能只写进 `SOUL.md` 期望
  LLM 自觉；提示词与运行时双保险，运行时为准。
- **可写记忆的失控风险**：Agent 持续往 `MEMORY.md` / `USER.md` 追加可能膨胀 / 噪声化 →
  需有体量上限或回收策略（后续可加 housekeeping），并保持人可随时编辑校订。
- **语言三分**（三者解耦，别把「文件写成什么语言」与「输出 / 记忆用什么语言」绑死）：
  - **模版 / 上下文文件**：统一 en-US 单份、不做 i18n（用户可改写成任意语言）。
  - **AI 输出语言**：由执行时注入的国际化规则控制，跟随 `config.language`。
  - **记忆写入语言**：Agent 追加 `MEMORY.md` / `USER.md` 时用用户习惯语言记录，此行为规则须
    显式注入提示词（见上「上下文注入」第 8 项、[i18n](../03-gui/04-i18n.md)）。
- **规则匹配语义与语言无关**。
- **后续可扩展**：Agent 规划器可接本机 agentic CLI（claude / codex 等，复用
  [pr-agent 运行时](05-pragent-runtime.md) 的本地 CLI provider 思路）作为编排大脑；
  工具目录可纳入更多只读分析工具（按 changed_paths 聚焦、跨 PR 关联等）而不动红线框架。
