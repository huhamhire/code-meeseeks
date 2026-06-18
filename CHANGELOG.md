# 更新日志（Changelog）

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **前端代码结构重构（可维护性）**：纯结构调整，对外接口与界面 / 交互行为均不变。重点：
  - 组件按 `common/`（基础 UI）/ `layout/`（应用骨架）/ `features/`（业务领域）三层归类；样式 `styles/` 同构归并
  - 超大组件按「容器 + 领域组件 + hooks + 工具方法」分层拆分：ChatPane、SettingsModal、MainPane、StatusBar
  - 业务逻辑下沉所属领域：PR 列表 / 详情 / 工作区归 `features/pr`；App 主入口退化为组合根，启动 / 布局 / 更新提示等拆成 app 级 hooks
  - 抽出通用基础组件 `Modal` / `StatusChip`；状态栏 chip 按归属下沉到各 feature
  - 其它整理：目录归并、工具方法去重、main 进程 splash 拆分

### Fixed

- Agent 评审 / 规划步骤行的固定文案（如「判断是否存在需追问的严重问题」「严重，追问 N 个」）此前在 `@meebox/agent` 层写死中文、被渲染层逐字显示，日 / 英 / 德界面下漏出中文；现按会话语言落地（zh-CN / en-US / ja-JP / de-DE，缺省回落英文），与评审总结骨架同策略。
- 设置页手动「检查更新」查到的新版此前不同步到状态栏、也不缓存：手动检查只把结果回给设置页本地，与定时检查各自为政、无共享。现 main 侧统一为单一真相源——手动 / 定时检查都缓存结果并在有新版时广播 `app:updateAvailable`，状态栏即时出现升级 chip；新增只读 `app:getUpdateStatus`，窗口 / 状态栏挂载时水合已知结果，不因重挂载而丢失。

## [0.5.0] - 2026-06-17

> 首个 0.5 正式版。本版重点：在 PR 评审中引入可委派的**高阶 Agent（会话 Agent 化 + AutoPilot 后台预评审）**，
> 并打磨无边框窗口、重型组件加载抖动、评论嵌套展示等体验。开发期 0.5.0-alpha.1 的变更已并入本版。

### Added

- **高阶 Agent（会话 Agent 化 + AutoPilot 预评审）**：在 PR 评审中引入可委派的智能体能力，随 LLM
  配置自动可用、无需单独的启用开关。
  - **一键自动评审**：聊天框命令区右侧新增自动评审按钮（✦ 图标），对当前 PR 跑「描述 → 评审 →
    （仅严重问题）条件追问 → 收尾总结」微流程，给出非约束性建议（建议通过 / 建议修改 / 建议人工
    复核）；过程步骤按自然时间顺序内联展示，结尾汇总为「评审总结」卡片。
  - **对话即委派**：聊天框直接输入自然语言，自由规划 Agent 按需调用只读工具（描述 / 评审 / 追问）
    完成请求——与 PR 内容相关但无明确工具指向时默认走追问兜底，与 PR 无关的请求则礼貌拒绝；运行中
    可随时停止。
  - **AutoPilot 后台预评审**：状态栏开关启用后，对满足最小间隔的新 PR 在后台自动预评审，建议倾向
    落入 PR 列表徽标，收尾总结同步落入该 PR 会话（与手动评审一致，可在聊天里看到「评审总结」卡片）；
    写操作经逐项授权 + 红线硬校验把关（默认全拒，仅开放只读工具）。准入从严：仅对
    **「待我评审」分类下、「待处理」状态**的 PR 触发；会话中一旦已有 `/describe` 或 `/review` 产出
    （手动或自动）即判定已评审、不再自动触发，避免重复评审。启用开关时（关 → 开）立即触发一次 poll
    并按上述规则评估、按需开评审，不必等下个轮询周期。评估节奏对齐轮询——每个 poller tick（间隔 =
    `poller.interval_seconds`）评估一遍，不再单设独立的最小间隔配置（准入门控 + 台账去重已防重复 / 打爆
    LLM）。PR 在 poll 中被移除 / purge 时，其上仍在执行的 agent 操作（编排 + 派发的工具 run）一律即时终止，
    不为已消失的 PR 空耗。多个待评审 PR 在一轮内并行编排，尽量填满工具的并发队列、不逐 PR 串行空等。
  - **评审状态可视化**：PR 列表项在同一位置展示——有在跑的 agent 任务时蓝色「执行中」旋转指示（复用
    运行卡片同款 .spinner、中心对称、无 chip 外框），否则展示评审建议 ★（手动 / AutoPilot 一视同仁，
    approve 绿 / needs_work 琥珀 / manual_review 蓝，SVG 居中）；AutoPilot 触发的评审在其**首个步骤行**
    打机器人标记，与手动触发区分。排队位次取全局队列位序（跨 PR 共享队列，不再每 PR 都显示「第 1 位」）。
  - **并行多问**：规划 Agent 可在一轮内并行派发多个 `/ask`（`tools` 元素支持 `{tool, question}` 形式），
    经运行队列并发执行，而非逐个串行。
  - **评审步骤 token 用量可见**：编排的每个推理步（判读 / 总结 / 自由规划）在步骤行右侧分步展示本步
    LLM token 用量（↑输入 / ↓输出，**不累计**）；工具调用（描述 / 评审 / 追问）的开销仍由各自运行卡片承载。
  - **Agent 上下文目录**：以 SOUL / AGENTS / MEMORY / USER 与 rules/ 规则子目录构成 Agent 的人格与
    知识来源；未配置自定义目录时默认落 `~/.code-meeseeks/agent`，首次启动幂等补齐模版，开箱即用。
- 设置页「运行环境」新增「关于 & 反馈」入口：GitHub 仓库（Star）/ 提交 Issue / Releases 三个外链
  （各带专属图标，点击经系统浏览器打开），低频社区入口集中于「关于」区、不进状态栏。
- **无边框窗口 + 自绘标题栏**（VS Code 风）：主窗口去掉系统原生标题栏，渲染层自绘 36px 标题栏，
  深色主题从顶贯通到底。窗控按钮交由系统绘制以保留原生行为——macOS 保留红绿灯（下移到标题栏内）、
  Windows/Linux 用 `titleBarOverlay` 在右上画最小化/最大化/关闭。标题栏展示品牌名与当前 PR 标题，
  Windows/Linux 开头另显应用图标（macOS 因红绿灯占位不显）。
- PR 列表项「执行中」标记覆盖 Agent **纯思考阶段**（无活跃工具运行时，含后台 AutoPilot），不再只在工具运行时显示。

### Changed

- **移除独立 `ollama` provider**，统一经 `openai-compatible` 接入本地 Ollama（Base URL 填
  `http://localhost:11434/v1`）：Ollama 自带 OpenAI 兼容端点，走此路径更标准稳健。旧 `ollama` 配置
  加载时**自动迁移**为 `openai-compatible` 并补足 `/v1`，存量无感升级。
- `openai-compatible` 经实测标记为**已验证**。
- **重型组件加载抖动收敛**：切换 PR / 文件时，diff（Monaco）、聊天会话内容等重型区域在
  异步初始化完成前统一盖一层居中 loading，就绪后一次性 reveal，消除「空白 → 内容弹出 → 折叠跳一下」
  的多段重排。loading 延迟显示（>150ms 才出现）——本地缓存命中的快切换零闪烁，仅真慢场景才落到
  loading。Monaco 区域特别处理：从挂载第一帧即盖遮罩、并等折叠（hideUnchangedRegions）布局 paint
  稳定后才揭开，遮罩底色与编辑器一致、揭开无缝。
- **describe「文件变更」分类默认折叠**：walkthrough 各文件分类（功能增强 / 配置变更 …）默认折叠收起，
  点分类标题按需展开，避免 describe 输出过长（仅作用于 walkthrough，不影响其它折叠区）。
- **评论嵌套展示统一**（评论 tab + 行内评论）：回复满 5 层后拉平为同一缩进层级、纵向排列并加横向分割线，
  避免无限右移；嵌套回复改走「左竖线缩进」的扁平样式（不再层层卡片「盒中盒」），两处视觉一致。
- 评审建议星标由五角星改为 AI 常见的四角 sparkle ✦。
- /ask 在问题末尾追加语言要求，改善按界面语言（中 / 日 / 德）作答的遵循度——此前自由问答常被大量英文 diff 盖过而用英文作答。
- 统一 PR 列表状态 chip 带高，消除「星标」与「星标 + 计数」等不同行的高度漂移。
- 评审总结不再硬截断：`summary_max_chars` 仅作提示词里的参考性软约束引导 LLM 收敛篇幅，AI 已生成的总结完整保留，不再被切在词中间（如「参数…」）。

### Fixed

- **修复 PR diff 基准随目标分支漂移导致的「修改被撤回」误判**：此前文件内容（Monaco 左栏）按目标
  分支当前 tip（`targetRef.sha`）读取，目标分支被别的 PR 合入而前移后，编辑器实际成了两点对比，
  别的 PR 的改动会以倒挂 / 撤回形式串进当前 PR 的 diff（变更文件列表用三点 diff 本不受影响，但内容
  与之不一致）。改为首次为 PR 算出 `merge-base(target, head)` 并固化到 `prs/<localId>/diff-base.json`，
  之后变更文件列表 / 文件内容 / 提交计数 / blame 改动行 / pr-agent 评审一律以它为 base：编辑器即真
  三点、对目标分支前移稳定，行锚点（评论 / finding）也有了固定参照。源分支被 rebase（固化 base 不再是
  head 祖先）时自动重算；正常 push 不失效。固化值为本地派生缓存、独立于平台元数据，poller 重写
  meta.json 不触碰；历史 PR 无需迁移，首次访问 diff 时按需回填（算不出则退回旧行为且不固化）。
- 修复 Windows 控制台中文日志仍显示为乱码：① dev 下 electron-vite 把 main 的 stdout 接成管道
  （`isTTY=false`）原会跳过转码，UTF-8 字节被 CJK 控制台按 GBK/SJIS 渲染——改为 `pretty` 模式不卡
  `isTTY`（与上色路径一致）；② 启动期探测真实活动代码页（`chcp`）替代按 locale 猜测：UTF-8 控制台
  （65001）直出 UTF-8，CJK 代码页（cp936/cp932/cp949/cp950）转码到对应页，避免用户已 `chcp 65001`
  切到 UTF-8 时反而把正确输出转乱。
- 修复 finding 锚点解析在文件路径含方括号（如 `a/[m-123]/x.ts`）时出错：marker `[file: …, lines: …]`
  的路径捕获原排除了 `]`，遇到路径里的 `]` 即误截，导致 marker 抽不出跳转锚点、且原样泄漏到
  finding 正文。改为带 lines 时以 `, lines:` 后缀界定路径（允许路径含 `[]`）。
- 清空某 PR 执行历史时一并清掉其 PR 列表 AI 评审建议 ★ 徽标，不再残留陈旧评审状态。
- 自动评审（手动 / AutoPilot）完成后，PR 列表的评审建议 ★ 现即时更新，不必等下个轮询周期才体现。
- PR「提交」数角标排除「源分支把目标分支合入自己」带进来的提交与 merge 提交，与「提交」列表口径一致（此前会多计）。
- 补 walkthrough 文件分类标题「Miscellaneous」「Formatting」「Dependencies」的中 / 日 / 德译文（此前非英文界面下仍显示英文）。
- Anthropic provider 配置的 base_url（自建 / 中转端点）此前未透传给底层 litellm → 请求仍打到官方 `api.anthropic.com`；现经 `ANTHROPIC_API_BASE` 正确透传（填根域名即可，litellm 自动补 `/v1/messages`）。(#65，感谢 @dnvyrn)
- 本地仓库镜像 clone/fetch 中途被打断后留下残缺镜像（缺 origin remote），导致后续拉取变更文件一直 fatal（`'origin' does not appear to be a git repository`）、点「重试」也卡在同一坏镜像：现自动识别不健康 / 损坏镜像并删库重建，可自愈。
- 消除评论页 poll / 刷新触发的渲染抖动：pr 按 localId 冻结后下传、评论内容结构相等就跳过重渲染、内嵌 Monaco 按锚点值 memo——定位信息没变时不再重渲染重排。

## [0.5.0-alpha.1] - 2026-06-17

> 开发期预览版。其全部变更内容已并入正式版 **[0.5.0](#050---2026-06-17)**，此处不再展开。

## [0.4.0] - 2026-06-14

> 第四个正式版（仍属 0.x · 早期预览）。本版重点：**接入 GitLab**（gitlab.com + Self-Managed，
> CE / EE），评审交互与渲染打磨（拒绝折叠收起、代码建议草稿锚点对齐、评论内嵌附件图片、GitHub /
> GitLab 评论编辑删除），**连接 Base URL 放宽**，以及 **Windows 升级安装健壮性**（per-machine 提权 +
> 绕过旧卸载器）。开发期 0.4.0-alpha.1 的变更已并入本版。
>
> ⚠️ **Windows 安装说明**：本版为 **per-machine 安装**（所有用户 / Program Files），安装器双击即弹
> UAC 提权运行；安装后的应用以普通权限启动。从旧版升级会自动清理旧安装，无需手动卸载。

### Added

- **GitLab 接入**（gitlab.com + Self-Managed，CE / EE，REST API v4）：新增 `@meebox/platform-gitlab`
  适配器——MR 发现（`reviewer_username` 待我评审，跨项目）、diff 评论读 / 发 / 改 / 删 / 回复
  （discussions + notes 归一）、合并、clone（PAT / SSH）、头像 / 内嵌附件代理。设置页与首启向导可
  新增 GitLab 连接（Base URL 可留空默认 gitlab.com）。
  - **CE / EE 审批降级**：MR approve/unapprove API 自 13.9 起为 Premium/Ultimate，且 GitLab 审批二元
    （无「需修改」）。经 `/metadata` 探测 edition，能力位据此降级——EE：通过 / 撤销；CE：无 API 审批、
    UI 灰显。可合并状态走 `detailed_merge_status`（full 保真）。
  - 嵌套 group 路径、N+1 取详情（diff_refs / 审批）、行内评论按 `position` 三 sha 锚定。

### Changed

- 拒绝代码反馈 / 改进建议后，卡片自动折叠收起并置灰：左色条转中性灰、类别 chip 置灰，正文与
  代码对比收起，仅保留头部与锚点行（含撤销入口）；头部 chevron 图标可临时展开回看。降低已决断
  项的视觉占用。
- 危险按钮（「清空」「删除」等确认操作）实底由偏浅的鲑红改为饱和红 `#c72e0f`，提高警示力。
- Windows 安装页不再强制展开文件日志列表：electron-builder 整包解包（`Nsis7z::Extract` +
  `CopyFiles /SILENT`）不产生逐文件日志，展开只会显示空白框、反而像卡住，改为仅保留进度条；
  卸载页仍展开（逐文件删除有真实进度）。
- **连接 Base URL 放宽**：GitHub Enterprise / GitLab Self-Managed 可直接填实例地址（如
  `https://ghe.example.com`），`/api/v3`、`/api/v4` 自动补全；github.com / gitlab.com 留空即用默认。
  免去记忆 API 路径（此前 GHE 漏填 `/api/v3` 会失败）。
- 设置页连接 / LLM 预设卡片显示对应**品牌类型图标**（代码平台 / LLM provider，与首启向导同源），
  一眼区分类型、避免误配。
- **本地 CLI 类 LLM provider 标注「实验性」**：卡片琥珀徽标 + 配置注释（🧪）+ 文档说明，提示其
  依赖上游 CLI（claude / codex 等）、行为可能随上游版本变更，稳定性与持续可用性不作保证。

### Fixed

- Bitbucket 评论内嵌附件图片不渲染：`rehype-sanitize` 的协议白名单（`src` / `href` 仅
  http/https）在 `urlTransform` 之前即剥掉 `attachment:` 内部协议，使 img/a 收不到 src/href、
  图片代理永不触发（属随 sanitize 链引入的回归）。schema 放行 `attachment` 协议；并让附件拉取
  失败不再静默吞错（记 status / 重定向 / 最终 URL / content-type）。
- 代码建议草稿区的锚定行与最终发布落点不一致：草稿预览按 `startLine` 渲染、发布却落
  `endLine`。统一以发布落点为准，草稿预览行与跳转高亮行改用 `endLine`，实现「预览位置 = 远端
  评论落点」（评论统一落在 finding 范围末行）。
- **GitHub 无法编辑 / 删除自己的评论**：评论可编辑 / 删除判定此前一律要求 `version`（仅 Bitbucket
  的乐观锁语义），而 GitHub / GitLab 评论无此字段 → 编辑 / 删除入口从不出现。改用「无需并发令牌」
  哨兵统一通过判定，恢复 GitHub / GitLab 评论的编辑与删除；「带 reply 不可删」收敛为 Bitbucket 专属。
- 评论内嵌图片代理失败时，降级为指向 PR 网页的「浏览器打开」链接（在系统浏览器带 session 渲染评论
  与图片），不再显示破图标；并修正相对图片路径在降级时误跳 localhost。
- **Windows 升级安装卡死 /「无法关闭」**：① 改为 per-machine 提权安装（清单 requireAdministrator，
  双击即弹 UAC、提权运行），取代 perMachine:false 在已存在 per-machine 安装时「按需提权失败 → 静默
  退出 → 双击打不开」的半吊子路径；② 升级时绕过 electron-builder 旧卸载器——在 customInit（早于
  uninstallOldVersion 执行）清掉旧版卸载注册表项使其读空值直接 no-op、改由安装器自行强删旧目录，
  规避旧卸载器原位 `_?=` 模式下「数万文件原子 rename、瞬时占用即整批回滚 → 重试 5 次后『无法关闭』」
  的死结。

## [0.4.0-alpha.1] - 2026-06-14

> 开发期预览版。其全部变更内容已并入正式版 **[0.4.0](#040---2026-06-14)**，此处不再展开。

## [0.3.1] - 2026-06-11

### Fixed

- **macOS 分发版「本地 CLI」provider（claude / codex）失效**（Finder/Dock 启动）：macOS GUI 应用
  只继承 launchd 的最小 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），读不到 shell 配置，故找不到装在
  `~/.local/bin` / homebrew 等目录的 CLI，评审报错（`litellm ... LLM Provider NOT provided` 或
  "找不到命令"）。启动期把常见 CLI 安装目录（`~/.local/bin` / `/usr/local/bin` /
  `/opt/homebrew/bin` 等）前置进 `PATH`，使嵌入式 python 及其 CLI 子进程都能定位命令。仅 macOS
  受影响；终端启动（dev）与 Windows 不受影响。(#21)

## [0.3.0] - 2026-06-11

> 第三个正式版（仍属 0.x · 早期预览）。本版重点：**界面国际化（四语 + 即时切换）**、Mermaid 架构图
> 渲染、版本更新检测、`/improve` 与 `/describe` 思路建议段等 pr-agent 能力扩展，并修复首启同步、
> 子进程树清理与安装 / 升级健壮性。开发期 0.3.0-alpha.1 的变更已并入本版。

> ⚠️ **Windows 用户升级注意**：若已安装**早期版本**（含 `0.3.0-alpha.1` 及更早），升级到本版前请
> **先手动卸载旧版**（设置 → 应用 → Code Meeseeks → 卸载，或安装目录下的 `Uninstall Code Meeseeks.exe`），
> 完成后再运行新安装器；否则覆盖安装可能长时间卡住或弹出「Code Meeseeks 无法关闭」。
> 原因：早期版本运行时会在安装目录写入上万个 Python 字节码（`.pyc`）缓存文件，使覆盖升级时「卸载旧版」
> 一步需逐个删除海量小文件、极慢甚至卡死。本版起运行时不再写入这些缓存，**之后的升级可正常覆盖、无需手动卸载**。

### Added

- **多语言界面（i18n）**：接入 **react-i18next**，全部 GUI 文本与主进程面向用户文案（目录对话框 /
  错误提示）从硬编码抽取为 locale 资源（按组件命名空间组织、递归字典序维护），覆盖 **简体中文 /
  English / 日本語 / Deutsch** 四语；pr-agent 输出模板的渲染期翻译同步语言感知（中文 / 日语 / 德语
  查表、英语 passthrough）。
  - **语言选择**：设置页与首启向导提供下拉选择（各语言以自身名称展示、不随 UI 翻译），**即时生效**——
    写盘 + 渲染层实时切换，AI 回复语言随之（下次运行起）。
  - **语言解析**：`config.language` 为空时按**操作系统偏好语言**自动匹配，非空则按显式选择。默认 /
    兜底语言为 **en-US**（缺译文回退英文而非中文）。
  - **按需懒加载**：默认语言（en-US）静态进入口（首帧不闪），其余语言由 Vite 拆成独立 chunk、切换时
    才拉取，不进入口包。`ja-JP` / `de-DE` 为机器初稿，发布前建议人工校对。
- **Mermaid 图渲染**：markdown 里的 `mermaid` 代码块（Qodo `/describe` 常生成的架构图）渲染为图形，
  覆盖 PR 描述 / 评论 / chat 评审输出。mermaid 懒加载（独立 chunk，仅出现图表时才拉取，不进入口包）；
  深色主题、`securityLevel: strict`，渲染失败回退原始代码块。
- **版本更新检测**：启动时（及设置页「检查更新」）查 GitHub Releases 最新稳定版与当前版本比对，
  有新版在状态栏提示并可点击前往下载（仅检测 + 提示，不自动下载 / 安装）。检测走配置的出站代理
  （内网友好），可经 `update.check_enabled` 关闭。
- **/describe 架构图**：嵌入式 pr-agent 统一启用 GFM（shim 让本地 provider 支持 gfm_markdown），
  使社区版 `/describe` 的 `enable_pr_diagram`（默认开）按实际改动**选择性输出 mermaid 架构图**，
  配合 Mermaid 渲染直接成图；`/review` 等同步走 GFM 富 markdown，输出解析（parse-output）相应
  兼容 GFM 的 `<table>` / `<details>` / `<a href>` finding 形态。
- **describe 排版优化**：架构图、文件变更各自独立成段，配中文色块标题（「架构图」/「文件变更」）；
  文件变更保留多级分类、每个分类独立成可收起/展开的折叠块（去掉无意义的 +1/-1 统计）；
  mermaid 图点击进入模态预览，支持滚轮缩放、拖拽平移与「适应窗口」，预览区为固定纯色背景。
- **清空执行历史**：chat 面板标题栏新增垃圾桶按钮，清空**当前 PR**的 PR Agent 执行历史记录（仅该 PR）。
- **启用 `/improve` 指令**：逐行代码改进建议（带 1-10 重要度评分）。依托 shim 的 GFM 支持走
  「汇总建议」路径（committable/inline 模式在本地 provider 下不可用，已显式关死兜底）；输出落
  独立 `improve.md` 与 `/review` 分流（经 `local.review_path` 原生配置）；关闭 persistent_comment
  避免本地 provider 翻历史评论刷无意义 traceback。
- **/describe 思路建议段**：shim 往 describe prompt 注入 `assessment` 字段，让社区版 `/describe`
  额外产出「思路建议」段——2-4 个替代实现方案（各自折叠）+ 倾向性推荐，对齐 Qodo Merge 的
  High-Level Assessment（社区版原生无此字段）。pr-agent 通用渲染成段、parse-output 映射 sectionKey，
  英文结构串经渲染期翻译表中文化，chip 配主蓝（信息性）色。

### Fixed

- 修复活动连接无缓存身份时首启「看似未触发远端同步」：改为先经 ping 确认身份、再立即同步一次
  （有缓存身份仍立即同步），不再用 me=null 跑半成品首轮。
- 修复取消 / 超时 / 退出时只终止 pr-agent 的 python 主进程、其 litellm 等孙进程变孤儿（Windows
  `child.kill` 不级联）：改为进程树级终止（win32 `taskkill /T /F`），避免孤儿进程锁住安装目录。
- **安装 / 升级健壮性**：嵌入式 python 运行期不再写 `.pyc`（`PYTHONDONTWRITEBYTECODE`）、运行时瘦身
  （删 tests / `__pycache__` / 类型存根等）+ 构建期端到端冒烟（防过度裁剪）；NSIS 安装器强杀残留进程
  不弹阻塞框 + 展开文件处理进度。减少安装目录小文件数，缓解升级时卸载缓慢 / 卡死。**已装早期版本仍需
  先手动卸载再升级**（见上方注意事项）。

## [0.3.0-alpha.1] - 2026-06-11

> 开发期预览版。其全部变更内容已并入正式版 **[0.3.0](#030---2026-06-11)**，此处不再展开。

## [0.2.0] - 2026-06-09

> 第二个正式版（仍属 0.x · 早期预览）。本版重点：**接入 GitHub**（github.com + GitHub Enterprise Server）
> 与多平台适配抽象、**评审任务并发执行**、**启动显著提速**，并**移除 Docker 运行策略**收敛到内嵌运行时。
> 开发期 0.2.0-alpha.1 / alpha.2 的变更已并入本版。

### Added

- **GitHub 适配**（github.com + GitHub Enterprise Server，REST API v3）：PR 发现、diff 评论读写、
  行内评论、审批（通过 / 需修改 / 撤销）、合并；设置页与首启向导可新增 GitHub 连接，连接配置中置顶。
  审批按平台能力降级：不支持的决断隐藏，自己作者的 PR 审批按钮灰显。GitHub Base URL 可选，留空默认
  `api.github.com`。
- **多平台适配抽象基线**：`PlatformAdapter` 能力描述符（`capabilities()`）、`PrDiffRefs`、`PrComment`
  线程字段（kind / threadId / nativeId）；UI 据能力位 显 / 隐 / 灰，不在调用处写 `if (platform === ...)`。
- **PR 发现分类**：GitHub 对齐仪表盘四类（待我评审 / 我创建 / 指派我 / 提及我）；Bitbucket 增
  「待我评审 / 我创建」两类。能力驱动 + 分类结果本地缓存，渲染层按标签本地过滤。
- **单活动连接模型**：PR 列表与状态栏只反映当前活动连接；切换活动连接后归档旧连接的 PR。
- **评审任务并发执行**：队列从单并发改为可配置并发（每个 run 独立 worktree + 独立子进程，并发安全），
  多个 PR 的 review 可并行、互不阻塞。并发数由 `pr_agent.max_concurrency` 控制（1~8，默认 2，仅
  config.yaml 手改）。同一 PR 同一工具运行 / 排队中禁止重复触发（`/ask` 不限）。
- **本地 CLI 模型 provider**（`cli`）：不直连模型 API，把评审请求转交本机已安装并授权的命令行工具
  （Claude Code / Codex CLI）执行评审；其凭据与计费由该 CLI 自理。
- 合并按钮等待态，防止重复点击。
- 新增面向用户的**使用说明**文档（`docs/guide/`，序号命名 + 索引）：安装与首次使用、代码平台配置、
  LLM 配置（含本地 CLI 模式）、网络代理、**配置文件参考**、**自定义评审规则**。

### Changed

- 全仓内部命名统一为 **Bitbucket**，去除 `BBS` / `BB` 等歧义缩写（纯改名，无行为变化）。
- 架构设计文档目录 `docs/modules/` → `docs/arch/`，统一定位为「架构设计文档」。
- **启动提速**：新增启动闪屏（splash）即时呈现品牌 logo + spinner；Monaco（~7.3MB）改 `React.lazy`
  懒加载，渲染入口包 ~10MB → ~2.6MB，窗口外壳不再等 Monaco 解析；pr-agent 探测移出建窗关键路径
  并发执行。
- **日志增强**：dev 控制台改 logfmt 单行（`<ISO8601> LEVEL msg="…" k=v`，按级别上色，文件仍 JSON）；
  渲染层未捕获错误 / rejection 经 IPC 回传 main，与主进程崩溃兜底一并落进 `meebox.log`。

### Removed

- **移除 Docker 运行策略**：容器文件系统装载效率低、与「零依赖」定位不符；嵌入式运行时（默认）+
  系统 local-cli 已覆盖全部场景。`pr_agent.strategy` 不再接受 `docker`。

### Fixed

- 修复模型返回多行自由文本值（如中文 `issue_content`）未用块标量、续行顶格导致 pr-agent `load_yaml`
  解析失败、整个 `/review` 崩溃（`NoneType is not iterable`）：`sitecustomize` 在解析失败时重排为块标量后重试。
- 修复 pr-agent `get_diff_files` 对删除文件 filename 取空导致行号片段渲染崩溃（回退取 `a_path`）。
- 修复首启向导平台卡视觉错位：GitHub 副标题缩短避免换行、图标固定宽度、文字在图标右侧区域居中。

### Security

- GitHub 图片代理仅对可信的 GitHub / GHE 资产域附带 PAT，避免凭据被带往第三方域。
- 升级 `nx` 至 22.7.5 并在范围内修复 `minimatch`，消除 `minimatch` ReDoS（high）依赖告警。

## [0.2.0-alpha.2] - 2026-06-09

> 开发期预览版。其全部变更内容已并入正式版 **[0.2.0](#020---2026-06-09)**，此处不再展开。

## [0.2.0-alpha.1] - 2026-06-09

> 开发期预览版。其全部变更内容已并入正式版 **[0.2.0](#020---2026-06-09)**，此处不再展开。

## [0.1.0] - 2026-06-08

> 首个正式版（仍属 0.x · 早期预览）。面向 **Reviewer 个人** 的本地化、半自动 AI 代码评审桌面客户端，
> 基于社区版 [pr-agent](https://docs.pr-agent.ai/) 构建：拉取待评审 PR、本地跑 AI 生成评审意见，
> 逐条确认 / 编辑后再发布到代码平台。**决策权在人、规则在本地、数据在本地。**

### 平台接入与 PR 发现

- Bitbucket Server / Data Center 接入（REST API v1，>= 7.0）。
- 轮询自动发现作为 Reviewer 的待评审 Open PR；按仓库分组、状态过滤、搜索。
- 首启配置向导：引导配置代码平台连接 +（可选）LLM；缺有效连接时下次启动仍回向导。
- 单例锁：二次启动聚焦已有窗口，不再多开。

### 本地 Diff 阅读

- bare 镜像（按需 clone / fetch）+ Monaco 并排 / 内联 diff。
- 文件树、行内评论、git blame、跨文件代码搜索。
- GitHub 风格未变更段折叠。

### AI 评审（pr-agent）

- 对话式驱动 `/describe`、`/review`、`/ask`，输出结构化成可操作的 findings。
- 评审任务队列：串行执行、排队任务在 chat 内可见、随时取消、失败重试。
- `/review` finding 行号锚点根因修复（注入 get_line_link，从结构化输出取 file:line）；finding 锚点可点击跳转到 Diff 对应行。
- 真实 token 用量采集（输入 / 输出分列）。
- LLM 未配置时 chat 面板给出明确提示并禁用输入。

### 评审 → 发布闭环

- findings → 草稿池 → 行内编辑（Monaco view zone）→ 单条 / 批量发布到远端。
- 发布后远端评论自动刷新；重复发布幂等（发完即删本地草稿）。
- 自己作者的远端评论支持回复 / 编辑 / 删除。
- 远端可合并时一键合并 PR；审批 / 合并远端失败时弹 toast 提示，不再静默。

### 个性化规则

- 每位 Reviewer 维护自己的规则目录（markdown + frontmatter），按项目 / 仓库 / 目标分支命中后注入评审。

### 多 LLM Provider

- 适配并实测验证：OpenAI、Anthropic、DeepSeek、阿里百炼（通义千问）、火山方舟（豆包）。
- 厂商原厂模型只填型号名即用（按 provider 自动补 litellm 前缀）。
- ollama / openai-compatible 理论可行（待验证）。
- 设置页连接 / LLM / 代理可视化 CRUD（草稿态「写入不启用」，保存或显式启用才应用）。
- 出站 HTTP 代理：LLM 调用 / 代码平台 / git HTTPS 统一走代理，本地地址自动直连。

### 运行时与打包

- 内嵌可重定位 Python + 固定版本 pr-agent，开箱即用，无需自装 Python / Docker（Docker 模式可选）。
- 桌面安装包：Windows x64（NSIS）、macOS arm64（dmg，ad-hoc 签名、未公证）。
- `sitecustomize` 无侵入补丁体系（带版本守卫）：二进制安全 diff、Anthropic 新模型去 `temperature`、
  YAML 容错（anchor marker 不破坏解析）、token 用量采集等。
- 修复：只读安装目录（如 `C:\Program Files`）下缺 `.secrets.toml` 导致的 pr-agent 启动告警 —— 占位文件改为组装期烤入随包分发。

### 隐私与数据

- 本地优先：除调用所配置的 LLM API 与代码平台外不向第三方上报数据。
- 配置 / 状态 / 日志固定在 `~/.code-meeseeks/`；仓库镜像目录可配置。

## [0.1.0-alpha.1] - 2026-06-07

> 首个公开预览版。其全部变更内容已并入正式版 **[0.1.0](#010---2026-06-08)**，此处不再重复展开。

---

许可证：[Apache-2.0](LICENSE)。打包内含第三方组件（pr-agent、Electron 等），各按其许可证分发，见 [NOTICE](NOTICE)。

[Unreleased]: https://github.com/huhamhire/code-meeseeks/compare/v0.5.0-alpha.1...HEAD
[0.5.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.4.0...v0.5.0
[0.5.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.4.0...v0.5.0-alpha.1
[0.4.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.3.1...v0.4.0
[0.4.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0...v0.3.0
[0.3.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0...v0.3.0-alpha.1
[0.2.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0
[0.2.0-alpha.2]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0-alpha.1...v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0-alpha.1
[0.1.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/huhamhire/code-meeseeks/releases/tag/v0.1.0-alpha.1
