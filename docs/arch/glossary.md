# Glossary — canonical terminology

This appendix locks the **canonical English rendering** of the recurring domain terms used across the architecture docs (`docs/arch/`). When writing or editing an arch doc, use the term in the **English** column; keep identifiers in the **Keep verbatim** section unchanged. The goal is one concept → one term, so the docs read consistently and map cleanly onto the (English) codebase. The Chinese column records the source term for traceability.

> These docs describe design, not code files. Prefer concept / type / function names over file paths, and let the reader grep by name.

## Disambiguations (read first)

A few concept pairs are easy to collapse into one English word — keep them distinct:

- **recommendation** vs **verdict** — `recommendation` is the non-binding review outcome (`approve` / `needs_work` / `manual_review`); a **(re-review) verdict** is the outcome of a re-review (`supersede` / `keep` / `withdraw`). Never render both as "verdict".
- **dispatch** vs **distribution** — routing a task (planner → sub-agents, tool → run queue) is **dispatch**; shipping a binary/artifact is **distribution / distribute**.
- **revoke** vs **dismiss** — the neutral review status action (approve / needs work / revoke) is **revoke**; the GitHub-specific API action (`.../dismissals`) is **dismiss**, used only when describing GitHub internals.
- **retire** vs **archive** — a PR leaving the active reviewer list is **retired** (lifecycle); **archive / archived** refers strictly to the cold storage location (`archived/prs/`).
- **follow-up ask** (noun) vs **follow up** (verb) — the noun is always "follow-up ask" (matches `max_followup_asks`); avoid bare "followup".
- **setup wizard** (prose) vs **`OnboardingWizard`** (the component) — use "setup wizard" in prose; write `OnboardingWizard` only when naming the identifier.

## Product / domain terms

| English (canonical) | Chinese | Notes |
| --- | --- | --- |
| review | 评审 | verb & noun |
| finding | 评审发现 / 发现 | keep `finding` in UI/agent contexts |
| draft / draft pool / draft candidate | 草稿 / 草稿池 / 草稿候选 | |
| re-review / re-review reference | 复评 / 复评引用 | |
| (re-review) verdict | 裁决（复评） | supersede / keep / withdraw — see disambiguations |
| supersede / keep / withdraw | 取代 / 保留 / 撤销（复评裁决） | |
| recommendation | 建议（评审结论） | approve / needs_work / manual_review — see disambiguations |
| follow-up ask / conditional follow-up | 追问 / 条件性追问 | noun; verb is "follow up" |
| micro-flow | 微流程 | hyphenated |
| orchestration / orchestrator / orchestration-level | 编排 / 编排器 / 编排级 | |
| planning loop (ReAct loop) / planner | 规划循环 / 规划 agent | |
| per-PR agent / sub-agent | 子 agent / 各 PR agent | |
| pre-review / auto review | 预评审 / 自动评审 | |
| admission gating / admission gate | 准入门控 / 准入闸 | not "gatekeeping" |
| ledger | 台账 | `AutopilotLedger` |
| dedup / dedupe | 去重 | |
| red line / tool mutation red line / red-line check | 红线 / 工具红线 / 红线校验 | |
| mutating tool / read · read-only tool | 修改类工具 / 读类·只读工具 | |
| grant | 授权（写权限） | README "per-item authorization" |
| agentic sessions | 会话 Agent 化 | doc-title concept |
| conversation-as-delegation | 对话即委派 | |
| direct tool (invocation) | 直达工具 | |
| tool catalog / tool registry | 工具目录 / 工具注册表 | |
| step / step count / max steps | 步 / 步数 / 步数上限 | |
| sub-task | 子任务 | |
| discovery category (filter) | 发现分类 | `PrDiscoveryFilter` |
| Review Requested / Created / Assigned / Mentioned | 待我评审 / 我创建 / 指派我 / 提及我 | lock to the UI labels |
| pending | 待处理 | `LocalPrStatus` |
| approve / needs work / revoke | 通过 / 需修改 / 撤销（审批） | |
| review decision | 决断（审批） | |
| unread / mention (@me) / reply | 未读 / 点名（@我）/ 回复我 | |
| unread mention count | 未读点名计数 | |
| cursor | 游标（lastMentionAt） | |
| archive / cold storage / soft-delete / retire / revive / reconcile | 归档 / 冷存储 / 软删 / 退场 / 复活 / 对账 | see disambiguations (retire vs archive) |
| grace period | grace 期 | |
| repo mirror / bare mirror / materialize | 仓库镜像 / bare 镜像 / 物化 | |
| three-dot diff / expanded diff / bare diff | 三点 diff / 展开 diff / 裸 diff | |
| match / matched (rule) / matched-rules chip | 命中（规则）/ 命中规则 chip | |
| rule / rules (rule system) / inject (injection) | 规则 / 规则系统 / 注入 | `extra_instructions` |
| capability (flag) / capability descriptor | 能力位 / 能力描述符 | `PlatformCapabilities` |
| graceful degradation / capability degradation | 能力降级 / 功能降级 | |
| grey out (disabled) / hidden (not rendered) | 置灰 / 隐藏不渲染 | |
| platform adaptation / domain service / domain split | 平台适配 / 领域服务 / 领域拆分 | |
| transport port | 传输端口 | `PlatformTransport` |
| optimistic lock / anchor | 乐观锁 / 锚点 | |
| inline comment / top-level comment · summary comment | 行内评论 / 顶层评论 · summary 评论 | |
| merge veto / publish | 合并否决 / 发布（评论） | |
| polling / Poller / projection (event projection) | 轮询 / Poller / 投影 | keep `Poller` |
| activity timeline | 活动时间线 | |
| system notification / toast / dock badge | 系统通知 / toast / dock 角标 | |
| setup wizard | 首启向导 / 首启配置向导 | component is `OnboardingWizard` |
| command palette | 命令面板 | |
| composition root / domain hook / module-level store | 组合根 / 领域 hook / 模块级 store | |
| frameless window / custom-drawn title bar | 无边框窗口 / 自绘标题栏 | |
| cross-PR state persistence | 跨 PR 保活 | |
| overview ruler | 总览标尺 | Monaco term |
| outbound network / egress / direct connection | 出站网络 / 出站 / 直连 | |
| credential / stored in plaintext | 凭据 / 明文落盘 | `SecretStore` |
| take effect immediately / hot-reload | 热生效 / 热更新 | |
| profile / active item | 预设（LLM）/ 生效项 | |
| local CLI provider / local CLI mode | 本地 CLI provider / CLI 模式 | |
| embedded runtime / (invocation) bridge / sentinel | 嵌入式运行时 / 调用桥 / 哨兵（行） | `@@MEEBOX_USAGE@@` |
| prompt cache / cache read (cache hit) / token usage | 提示缓存 / 命中量（cache）/ token 用量 | |
| context tiers / layered context / context injection | 上下文分层 / 三层上下文 / 上下文注入 | |
| writable memory / long-term memory / user profile / soul | 可写记忆 / 长期记忆 / 用户画像 / 灵魂 | `USER.md` / `SOUL.md` |
| seed / scaffold | 播种（示例规则）/ 脚手架 | |
| error code / domain tag / fallback code | 错误码 / 领域标签 / 兜底码 | `ErrorCode` |
| wire format / wire contract / structured clone / envelope | 传输契约 / wire 形态 / 结构化克隆 / 信封 | |
| local API service / write boundary / write action | 服务监听 / 本地 API / 写边界 / 写动作 | |
| change-type (mutating) tool / gating / compact projection | 变更类工具 / 门控 / 精简投影 | |
| dispatch / distribution | 分发（任务）/ 分发（发布物） | see disambiguations |
| cross-compile / thin client / command tree / domain group | 交叉编译 / 瘦客户端 / 命令树 / 领域组 | |
| root-level system command | 系统性命令（根层级） | |

## Skeleton headings (recur per doc)

| English | Chinese |
| --- | --- |
| Responsibilities & boundaries | 职责与边界 |
| Core design | 核心设计 |
| Data / interface contract | 数据 / 接口契约 |
| Extension & caveats | 扩展与注意事项 |
| Scope | 范围 |
| Functional design | 功能设计 |
| Related / See also | 关联 |
| Legend | 图说 |
| Key trade-offs | 关键取舍 |
| Implemented / Rejected / Under evaluation (deferred) | 已实现 / 已否决 / 待评估（暂缓） |
| Commands & shortcuts | 命令与快捷键一览 |
| Interaction conventions | 交互规范 |

## Stock phrases (house style)

| English | Chinese |
| --- | --- |
| Describe the design; don't reference code files | 描述设计，不引用代码文件 |
| source of truth / single source of truth | 事实来源 / 单一真相源 |
| the human decides | 决策权在人 |
| high-level view | 高层视角 |
| adapt / degrade per platform capability | 按平台能力自适应降级 |
| best-effort; silently degrade on failure | best-effort / 失败静默降级 |
| read fresh / assemble fresh on each run | 每次 run 现读现装配 |
| zero extra fetches | 零额外取数 |
| bounded / unbounded | 有界 / 无界 |
| conclusion first | 结论先行 |
| local-first / data stays local | 本地优先 / 数据留在本地 |
| zero dependencies / works out of the box | 零依赖 / 开箱即用 |
| doesn't silently truncate | 不静默截断 |
| idempotent / single writer / atomic write | 幂等 / 单写者 / 原子写 |
| backstop / safety net | 安全兜底 |

## Keep verbatim (identifiers — do not translate)

Type / identifier / API names stay exactly as written in code. Non-exhaustive, by area:

- **Platform core**: `PlatformAdapter`, `PlatformConnection`, `PullRequestService`, `CommentService`, `MediaService`, `PlatformTransport`, `PlatformDomainService`, `ConnectionContext`, `composePlatformAdapter`
- **Shared domain types**: `PrIdentity`, `PrComment`, `PrCommentAnchor`, `PrDiffRefs`, `PrReaction`, `MergeStatus`, `MergeVeto`, `MergeVetoCode`, `PlatformCapabilities`, `PrDiscoveryFilter`, `LocalPrStatus`, `PrListItem`
- **Git layer**: `worktree`, `bare clone`, `blame`, `simple-git`, `refspec`, `hardlink`, `LFS`
- **Electron / IPC**: `IPC`, `ipcMain.handle`, `invoke`, `IpcChannels`, `contextBridge`, `contextIsolation`, `nodeIntegration`, `CSP`, `preload`, Main, Renderer
- **pr-agent runtime**: `pr-agent`, `LocalGitProvider`, `litellm`, `sitecustomize`, `monkeypatch`, `shim`, `meta_path finder`, `CPython`, `extraResources`, `asar`, `MockResponse`
- **Env / sentinel / token fields**: `@@MEEBOX_USAGE@@`, `MEEBOX_CLI_MODE`, `MEEBOX_CLI_BIN`, `MEEBOX_CLI_WORKDIR`, `MEEBOX_CHAT_CACHE`, `CACHE_BREAK`, `EXTRA_INSTRUCTIONS`, `extra_instructions`, `num_turns`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cached_input_tokens`
- **Rules**: `frontmatter`, `gray-matter`, `Ruleset`, `applies_to`, `priority`
- **Agent / orchestration**: `ReviewRun`, `Finding`, `AgentSession`, `AgentStep`, `ReviewRunTool`, `buildToolCatalog`, `ToolCatalogEntry`, `TOOLS`, `tool-registry`, `REVIEW_STEP_REGISTRY`, `ReviewStepKind`, `AutopilotLedger`, `PlannerPass`, `QueueItem`, `AutoPilot`, `planner`, `ReAct`, `AbortController`
- **State storage**: `StateStore`, `JsonFileStateStore`, `StoredPullRequest`, `PrIndexEntry`, `PrReadStateFile`, `relocateTree`, `schema_version`, `localId`, `remoteId`, `subpathInside`
- **Config / errors**: `AppError`, `ErrorCode`, `ERROR_CODES`, `SecretStore`, `zod`
- **i18n**: `react-i18next`, `useTranslation`, `resolveLanguage`, `matchSupportedLanguage`, `SUPPORTED_LANGUAGES`, `fallbackLng`, `nonExplicitSupportedLngs`, `partialBundledLanguages`, `translatePrAgentLabels`, `CLDR`
- **Renderer**: `Monaco`, `DiffView`, `DraftZone`, `ChatPane`, `MainPane`, `Sidebar`, `StatusBar`, `TitleBar`, `OnboardingWizard`, `SettingsModal`, `DraftsPanel`, `view zone`, `useSyncExternalStore`, `useDockBadge`, `RunMeta`
- **Networking**: `PAT`, `SSH`, `loopback`, `undici`, `dispatcher`, `HTTP(S)_PROXY`, `NO_PROXY`, `ProxyFetchFactory`, `ProxyCommand`, `Basic Auth`, `socks5`
- **CLI / integration**: `meebox`, `cobra`, `GOOS`/`GOARCH`, `go:embed`, `SKILL.md`, `cli.yaml`, `config.yaml`, `MEEBOX_API_URL`, `MEEBOX_TOKEN`, `X-Meebox-CLI-Version`
- **Platform API nouns** (keep per platform): `dashboard`, `X-AUSERNAME`, `multilineMarker`, `in_reply_to_id`, `mergeable_state`, `detailed_merge_status`, `discussions`, `notes`, `award emoji`, `Twemoji`, `X-Atlassian-Token`
