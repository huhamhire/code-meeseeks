# 更新日志（Changelog）

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- agent 自动评审自动「复评 / 取代」review 评论：自动评审微流程（describe→review→judge→asks→summary）里，judge 现可对某条 review 代码评论（finding）出**复评追问**（按 id 点名 `targetFindingId`），asks 步以复评模式跑该追问（携 `referencedFinding`），裁决为「取代 / 撤销」时**自动关闭**被取代的原 finding（建立 `FindingClosure`，原卡转关闭态并与复评 ask 卡互链）——无需用户手动点「引用」。默认开启、保守：仅 judge 明确点名某条 finding 且复评裁决为 replace/drop 时才关闭，keep / 未点名不动；新评论不自动落草稿，仍由用户在复评卡手动「采纳」（与手动引用路径一致）。复用 `/ask` 复评闭环的数据与渲染（`referencedFinding` / `askVerdict` / `FindingClosure`）。

- `/ask` 复评引用闭环：可对先前 review/improve 在 ChatPane 生成的代码评论建议（finding 卡片）发起「复评」。finding 卡片新增「引用」按钮 → 把该条挂到输入栏（复用 diff 选区引用的 chip + 预填可编辑的默认复评问题），发送后本条 `/ask` 携带该引用走复评模式：按结构化分段额外产出裁决 `<verdict>`（取代 / 保留 / 撤销），结果卡顶部显示「复评自 <file:line>」徽标（点击回链原卡）+ 裁决 chip + **手动**动作。「采纳并关闭原」把建议作为新评论草稿锚定原位置并关闭原 finding；「关闭原评论」仅关闭；关闭后原 finding 卡转「已被复评取代/关闭」态（折叠 + 撤销关闭 + 互链到复评卡）。关闭关系独立持久化（非草稿语义），新增 `findingClosures:list/create/delete` 通道与 `findingClosures:changed` 事件、`ReviewRun.referencedFinding` / `askVerdict` 字段。仅 `/ask`；agent 自动评审里 ask 自动关联 / 取代 review 建议为后续迭代。

- `/ask` 结构化分段输出：自由问答此前无结构、冗长，reviewer 难以快速获取信息。现经提示词约束模型按确定性分段输出——`<summary>`（结论 / 直接回答，绿色高亮、默认展开）、`<analysis>`（过程性分析 / 讨论，灰色、**默认收起**可展开）、`<suggestions>`（可执行建议，琥珀色高亮）。解析层按标签切段成独立卡片（模型未遵循 / 无标签时整体回退普通解析，不破坏既有行为），渲染层按段着色 + 过程段折叠，关键结论与建议一眼可见。仅 `/ask`，`/describe`、`/review` 输出不变。

- CLI 模式 `/ask` 取完整文件上下文：本机 CLI（claude / codex）接管 LLM 时，`/ask` 自由问答此前只能基于 diff 推理、读不到仓库完整文件（CLI 子进程被钉在中性临时目录以隔离仓库自带指令）。现仅对 `/ask` 经 `MEEBOX_CLI_WORKDIR` 把子进程 cwd 落到一次性 worktree，能读真实文件作答（如「某函数在别处被谁调用」）；落 cwd 前清空该 worktree 内仓库自带的 agent 指令文件（`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor` 规则 / `.github/copilot-instructions.md`），避免被评审 PR（worktree 即 PR HEAD、作者可控）经指令文件注入 / 污染回答。`/describe`、`/review` 维持中性临时目录不变；API 模式不涉及（远程接口本就只有 diff）。

- Agent 会话「中途输入」与「计划」：Agent 运行期间再输入消息不再被静默丢弃——即时显示用户气泡并入队，下一主 Agent 周期并入、与当前进度对比后重排后续行动（评审微流程跑完后接续处理排队消息；无在跑则直接起一轮规划）。规划 Agent 维护一份可视的「计划」(todo) 面板：每轮给出 / 更新步骤、随进展勾选、收到新输入按最新指令重排；随会话持久化，切 PR / 重启经 `agent:getSession` 恢复。新增 `agent:enqueueMessage` 通道与 `agent:planUpdated` 事件。

- Diff 选中代码引用进提问：在 Diff 选中若干行后，聊天输入栏 AutoReview 按钮右侧出现「N 行已选中」角标（竖线分隔），点击可切换忽略态（eye-slash + 置灰）——忽略时本条消息不带引用。发送 `/ask` 或自然语言提问时，选中代码作为**隐式上下文**注入模型（带文件路径 + 行范围 + base/head 侧），不进入会话气泡、不落盘（`agent:ask` / `pragent:run` 增可选 `referencedContext`，经 EXTRA_INSTRUCTIONS / 规划当轮提示注入，且约束不透传给 pr-agent 工具）。引用不受「可评论区域」限制，未改动的上下文行同样可引用。统一(inline)视图下删除行无法被光标选中，但 head 选区跨到的删除 / 改动 hunk 会据 diff 映射从基线侧取出真实代码一并引用（删除内容也能像添加行一样被引用）；并排视图删除行可直接选中。切换 PR / 选区塌缩即清。

- Diff 滚动条总览标尺：diff 增 / 改 / 删与「有评论的行」投影到滚动条旁的总览标尺（编辑模式风格，按 1/3 分道、中间留白，不启用 minimap），拖动滚动条即可快速定位变更与评论位置。增 / 改按行高显示；并排视图删除在左侧 original 编辑器标尺按行高标红，统一(inline)视图下删除行无 model 行号、以删除点标记。

- Diff 标签支持按「变更范围」查看：文件树头部「<n> 个文件」补充范围信息，变为「<n> 个文件 · 全部变更」或「<n> 个文件 · <commit>」，整体可点击弹出下拉，选择查看「全部变更（PR base..head）」或某个 commit 的变更（该 commit 的 `parent..sha`）。提交 / 活动标签页点击 commit 不再跳浏览器，而是切到 Diff 标签本地渲染该 commit 的变更。commit 视图为只读 diff（行内评论 / 草稿锚定在 PR 全量 diff 行号上，不套用于单 commit）。`diff:listChangedFiles` / `getFileContent` / `getBlame` 增加可选 base/head 范围参数。

- Diff 支持给「删除行」新增行内评论 / 草稿：此前 hover「+」只挂在 head 侧（新增行），现并排视图下 base 侧（删除 / 上下文行）也可 hover「+」创建，锚定 `side: 'old'`（发布映射 Bitbucket `lineType: removed / fileType: FROM`）。统一(inline)视图下删除行以 view zone 呈现、无可 hover 行号，仍需切并排视图创建。

- Diff 文件树标注合并冲突文件：有冲突的 PR（`pr.hasConflict`）打开 Diff 时，对会冲突的文件在右侧状态圆点左侧标一个琥珀色三角警示图标（hover 提示「合并到目标分支会产生冲突」），无需逐文件试合并即可一眼定位冲突所在。冲突文件由后端就 PR 目标分支 tip ⟂ 源 head 跑本地 `git merge-tree --write-tree` 试合并解析得到（新增 `diff:listConflictFiles` 通道，仅 `hasConflict` 为真时实际试合并、失败保守不标记）。

- PR 评审界面交互细节优化：合并按钮去掉「常绿填充」（易误判为已点击），改为与 approve 同款基础态 + 1s blink 突出可点击、点击后沿用 disabled 灰显；提交标签页表格行高加高、表头字号不小于正文；活动视图 inline 评论的「文件:行号」锚点可点击，直接跳到 Diff 标签对应位置；活动内容区宽度在 [480, 960] 内自适应、窄于 480 转横向滚动（修正窄宽下被 ChatPane 遮盖）；PR 头部「冲突」标记改为带色 chip 展示。

- PR 详情标签页交互优化：整面板国际化（原「描述 / 时间线」写死中文、「Reviewers」写死英文，现按界面语言出文案）；reviewer 列表参照活动时间线行式展示（前置状态图标 + 头像 + 名 + 决断 chip，「评审者 / 已批准 / 要求修改 / 待评审」）；时间线精简为「远端创建 / 远端更新 / 最近更新时间」（移除「本地首次发现」）；改为左右布局（左描述、右时间线 + 评审者），面板窄到阈值时按容器查询响应式将侧栏堆叠到描述下方；侧栏限宽 400px、时间小字号右对齐，避免元素过散。

- PR 详情「评论」标签页演进为「活动」时间线（GitHub / Bitbucket）：把评论、提交更新、reviewer 评审决断（approve / needs-work / unapprove / dismiss）按时间倒序归并为一条活动时间线，保留原有评论内容、排序与编辑 / 回复 / 删除 / 内联代码能力。新增统一的 `listPullRequestActivity` 平台契约——GitHub 取自 `/pulls/{n}/reviews`、Bitbucket 取自 `/activities`（带时间戳的决断事件）。提交另保留独立「提交」标签页。
  - 视觉：各条目统一为「图标节点 + 头像 + 加粗作者名 + 动词 + 时间」，一条竖向虚线轨贯穿图标列连接相邻条目；评论标题统一为「xxx 评论」并前置评论图标，正文整体缩进成挂在轨上的卡片；作者头像 / 文本与评论主体人一致，不做差异化。评审决断动词统一为「批准 / 要求修改」并用带色 chip（绿 / 琥珀 / 中性）突出。时间标签 hover 显示精确到秒的实际时间点。
  - 新建评论：标签栏右侧「评论」按钮可直接发一条不锚到文件的 summary 评论，编辑框作为时间线首个节点（头像在轨上、编辑框缩进）展开，发布后新评论即时出现在顶部（新增 `publishSummaryComment` 平台契约 + `comments:create` 通道）。
  - GitLab 走差异化设计：无统一活动事件源（CE 无审批、审批系统 note 解析脆弱），标签页保持纯「评论」视图（`capabilities.activityTimeline=false`），不混入提交 / 决断。

- 连接 / LLM 配置模态退出拦截：编辑配置时若存在未提交改动，关闭（背景点击 / 取消 / 关闭键）会弹确认框拦截，确认放弃才关闭，避免误丢未保存内容。

- PR 头部展示 reviewer 头像栈：在标题右侧、动作按钮行之上垂直居中展示评审者头像（Bitbucket 风格略重叠、灰色细描边环），按 needsWork > approved > 待评审 优先排序并过滤掉当前用户自己；approved / needsWork 的头像右上角带决断角标（圆环内绿勾 / 琥珀叹号）。至多展示 4 个，超出则显示 3 个 + 「+n」，点击「+n」下拉展示其余评审者（头像 + 名 + 决断 chip）；直接展示的头像 hover 出名字。

### Changed

- ChatPane 评审结果交互打磨（一批小优化）：
  - 移除「已达并发上限」横幅——触达上限本就自动进排队（仍有队列卡片 + 状态栏队列 chip），强提示无实用价值。
  - finding 卡的「编辑 / 拒绝」由 anchor 行的文字按钮改为头部右上角图标栏的图标（评论气泡 / 圆形禁止），排在「引用」转发箭头左侧，与标题同排成组；anchor 行仅保留草稿状态 / 复评关闭 chip。
  - 删除按钮统一为高饱和危险红：单条记录删除（垃圾桶）与顶部「清空历史」hover 由偏浅鲑红改为 `$color-danger-strong`，与拒绝 finding / `.btn-icon-danger` 一致。
  - `/review` 输出隐藏「评估工作量」（effort）段——实用价值低，不再展示。
- 复评 `/ask` 取代 / 撤销改为静默自动关闭：引用某条 review/improve 评论发起的复评 `/ask`，裁决为「取代 / 撤销」时**自动**关闭被引用的原 finding（建立关闭关系），无需再手动点「关闭原」；裁决「取代」时把建议提升为**带代码定位**的代码反馈卡（取原评论的 anchor），渲染 / 采纳同 `/review` 代码反馈（点头部评论图标即转为锚定原位置的行内评论草稿）。裁决「保留」不动、且不再展示「保留原评论」标记（无破坏性动作，标记冗余）。关闭纯由后端裁决驱动：移除结果卡面向用户的「采纳并关闭原 / 仅关闭原 / 关闭原评论」与原 finding 卡的「撤销关闭」按钮，前端仅**只读**展示「已被复评取代/关闭」chip + 「查看复评」导航（引用发起复评、点击引用徽标定位高亮原卡仍在）。
- `/ask` 引用展示简化与文案微调：复评结果卡顶部徽标与输入框引用 chip 不再用「复评自 / 复评 …」文案，直接显示引用定位（结果卡：转发箭头 + **完整路径:行号**，换行规则同代码建议定位、点击回链原评论；输入框 chip：只显示**文件名**），删除 `chipLabel` / `reviewedFrom` / `reviewedFromTitle` 三个 i18n key 减少维护；`/ask` 结构化「分析过程」段标签改为「分析解读」，其正文 H2 小节标题字号调小（靠加粗区分）、小节间用分割线隔开；该段展开时在 chip 行下加一条分割线，与下方富文本内容衔接更自然。
- agent「评审总结」聚焦 PR 整体结论：`/ask` 改富文本后，追问答案（表格 / 代码块 / 逐条建议）此前被整段灌进总结输入、诱导模型照搬明细，背离「总结=控制篇幅的整体结论」初衷。现总结只吃每条追问的**结论**（ask-summary），提示词重写为「综合描述 / 评审发现 / 追问结论 → 输出 PR 整体结论，不复制明细」，并允许总结内适度用表格 / 引用 / emoji；「概述 / 发现 / 建议」三段间加分割线。
- `/ask` 结论段标签由「概述」改为「结论」（四语言对齐：Conclusion / 結論 / Fazit），更贴合其「直接结论」定位。
- PR 头部 reviewer 头像决断角标反色：由「白底 + 彩色勾/叹号圆环图标」改为「实心彩色圆底 + 纯白勾/叹号符号（去掉图标外圆环，只留内部符号）」+ 与头像同款灰色描边环，白色面积更小、更醒目。

- **Agent 编排响应提速**（评审微流程 / 自由规划）：一批降延迟与降成本优化，对用户行为不变。
  - 条件追问并行：判读为「严重需追问」时，多个 `/ask` 由串行改为并行派发（同 describe + review 模式，错开起跑、保序），多追问场景明显更快。
  - 追问判读瘦身为轻量路由：判「是否需追问」不再带整份 agent 系统上下文（SOUL / 记忆 / 用户档 / 工具目录 / 规则 / PR 元数据），仅凭 describe + review 结果判断，输入 token 大降；追问问题随会话语言书写（不再固定英文）。
  - 编排通道（判读 / 收尾 / 规划）全模式低推理 + 判读输出封顶：CLI（claude→haiku、codex→reasoning_effort=low）之外，API / litellm 路径补 `reasoning_effort=low`（仅对 reasoning 类模型生效、其余无副作用），并给判读这类轻量路由封顶输出，避免一个 yes/no 决策吐大量 token；均仅作用于编排 chat，`/review` 等工具 run 仍满档推理。
  - 全局系统前缀走 Anthropic 1h 提示缓存：系统上下文拆为「全局稳定前缀（SOUL / AGENTS / 工具目录 / 记忆 / 用户档）」+「PR/运行相关尾部」，稳定前缀标服务端提示缓存（ephemeral, 1h），跨 PR / 运行在窗口内命中、降延迟与成本；OpenAI / DeepSeek 自带自动前缀缓存、无需额外处理。

- **Agent 引擎可维护性重构**（行为不变）：① 抽出可插拔「步骤」抽象（StepRecorder / StepHandler），评审微流程拆为有序步骤（describe-review / judge / asks / summary）+ 注册表、规划 ReAct 抽为单步循环，统一此前各自重复的记步与用量累计；② 编排提示词外置到 `resources/prompts/*.md`（协议 / 判读 / 总结 / AutoPilot 判定，Vite `?raw` 内联 + `{{占位符}}` 注入、残留占位即抛错），脚手架模板归入 `resources/template/`。

- **前端代码结构重构（可维护性）**：纯结构调整，对外接口与界面 / 交互行为均不变。重点：
  - 组件按 `common/`（基础 UI）/ `layout/`（应用骨架）/ `features/`（业务领域）三层归类；样式 `styles/` 同构归并
  - 超大组件按「容器 + 领域组件 + hooks + 工具方法」分层拆分：ChatPane、SettingsModal、MainPane、StatusBar
  - 业务逻辑下沉所属领域：PR 列表 / 详情 / 工作区归 `features/pr`；App 主入口退化为组合根，启动 / 布局 / 更新提示等拆成 app 级 hooks
  - 抽出通用基础组件 `Modal` / `StatusChip`；状态栏 chip 按归属下沉到各 feature
  - DiffView 退化为组合根：数据流（变更文件 / 内容 / 评论 / blame / 范围 / 跳转）拆成 hooks，行内 view-zone 装配抽象为通用 `mountInlineZones`，行内评论渲染独立成域；评论渲染原语（`useCommentThread` / `CommentMarkdown`）与「活动」标签页共用
  - DiffSearchPanel / DraftZone / ChatInputBar 三个单体组件拆分：搜索算法、read/edit/publish 状态机、命令解析 / 输入状态机各抽为 util / hook，组件退化为瘦渲染
  - `components/common` 收敛 `index` barrel，跨域 import 统一走 barrel
  - 其它整理：目录归并、工具方法去重、main 进程 splash 拆分

- 设置面板「连接 / LLM 配置」模态复用首启向导的左右布局：左侧选集成平台 / LLM provider、右侧填表单（复用的 `PlatformPicker` / `LlmProviderPicker` 统一在 settings 域维护，首启向导同步复用）。LLM 模态与向导 LLM 步改为固定高度、两栏各自滚动——切换 provider 不再抖动、provider 列表后续扩展也不撑高，向导两子步等高对齐；CLI 模式补「实验性」标记、名称 / 命令占位提示 `claude / codex`、文案精简（去品牌名与内部细节）；必填校验改为只标红框（去错误文案、消除控件位置抖动）；「测试连接」按钮收窄为 `btn-sm` 并与结果文案垂直对齐。
- 危险按钮统一为高饱和度红描边：新增 `$color-danger-strong` token，删除评论（评论 tab + 行内）/ 删除草稿 / 删除连接 / LLM、停止、拒绝 finding 等按钮 hover 由偏浅鲑红改为与模态删除按钮同色系的饱和红，警示力更强、全局一致（保留 ghost 描边风格，不改为实底）。

- PR 提交列表 / 活动时间线按 first-parent 过滤合入的他人提交：平台 `/commits` 返回 `target..source` 全集，长期分支 / fork 同步分支历史上反复把别的分支 merge 进源分支，会带出大量 merge 提交与合入的他人提交、淹没本 PR 真正引入的提交。改用本地镜像 `git rev-list --first-parent --no-merges merge-base..source` 算「本 PR 自产提交」SHA 集合对平台返回做交集过滤；提交数角标同口径对齐；镜像未就位 / 算不出时回退未过滤列表、不丢信息（三平台统一收口）。

- ChatPane / Diff 评审界面一批交互打磨：评审总结卡与 finding 卡同宽、加蓝色左条（与蓝色淡底成一套）；可折叠卡（分析解读 / 已拒绝 / 被复评关闭的代码反馈）整行标题区即展开 / 收起热区、收起态上下内边距对称、折叠 / 展开带高度过渡动画（尊重「减少动效」）；已有评论的行也可 hover「+」继续追加行内评论（新评论按时间序展示在已有评论下方）；点击复评引用徽标精确定位到原 finding 卡并按其类别色闪烁高亮（已关闭 / 拒绝卡用中性灰），引用徽标图标随首行、行号跟随路径末行排版修正；diff 头部 reviewer 打勾角标缩小一号并去描边环；「原始输出」折叠标题去掉「(xx chars)」字数；判定解析失败的兜底不再输出「无法解析建议，转人工复核」灰字（仅保留判定徽标）；「思路建议」折叠方案标题支持内联 markdown（`代码` / **强调**，shim 提示词同步放开标题禁用反引号的限制）；评审总结正文行距 / 字号与其它卡片统一（$fs-md → $fs-lg / $lh-normal）。

### Fixed

- 复评 `/ask` 取代裁决的「改进建议」改为可直接发布的评论本身：此前 `<suggestions>` 常被写成「建议将原评论替换为…/请确认…」这类**关于评论的元讨论**（还出现「原评论」概念），无法被评审者直接采用。现提示词要求 `replace` 裁决下 `<suggestions>` **只包含替代评论本身**——以标准 review 评论的口吻直接针对代码、按问题 → 影响 → 建议分段、可原样发布，不提「原评论 / 替换 / 请确认」等元信息；被取代的原评论仍按 `replace`/`drop` 裁决自动关闭。
- CLI 模式 `/ask` 在「仓库自带 agent 指令文件被纳入版本管理」时整体失败：为防 CLI 子进程自动加载污染回答，`/ask` 会截断 worktree 内的 `CLAUDE.md` / `AGENTS.md` / `.cursor` 规则等；若这些文件被仓库跟踪，截断即让工作区变「脏」，触发 pr-agent `LocalGitProvider._prepare_repo` 的「repository is not in a clean state」守卫 → 取 git provider 阶段就崩、不写 `review.md`、`/ask` 失败（无此类跟踪文件的仓库不受影响）。修复：shim 覆写 `_prepare_repo` 去掉脏检查、仅保留「目标分支存在」校验——diff 取自分支提交（与工作区脏无关），该守卫对这套一次性受控 worktree 是误报。
- 失败 / 取消的任务不再做结构化采集：`/ask`（及其它工具）run 失败（含 exit 0 但 LLM 调用失败）或被取消时，此前仍会把部分 / 报错输出解析成 finding 卡，易产出无意义的结构化元素。现失败 / 取消路径**不解析 findings**，只保留原始输出（stdout/stderr）供展示；复评 `/ask` 失败时也不触发自动关闭 / 建议提升。
- `/ask` 的结构化分段 / 引用上下文 / 复评裁决指令此前对模型无效：pr-agent 的 `pr_questions` 提示词模板**不渲染 `extra_instructions`**（与 `/describe`、`/review`、`/improve` 不同），我们经 `PR_QUESTIONS__EXTRA_INSTRUCTIONS` 注入的这些指令对 `/ask` 是死字段、被静默丢弃，导致结构化输出 / 复评取代评论的代码定位时有时无。现 `/ask` 的这些指令改为拼进「问题」本身（user turn，唯一真正到达模型的文本，与语言后缀同路）；问题回显（含字面 `<summary>` / `<verdict>` 示例标签）按 pr-agent 固定的 `### **Answer:**` 表头整段切除，避免污染结构化解析。
  - 结构化只作「轻包装」、不削减原生表现：`<analysis>` 保留 pr-agent 原生 `/ask` 的富文本（表格 / 代码块 / 子标题 / 分段、深度照常）。此前误把面向 `/review` 的「每段末尾追加 anchor marker」指令也套给 `/ask`（指令真正送达后）→ 模型为遵守而回避表格 / 代码块、回答被压成平铺纯文本；现对 `/ask` 取消该全局逐段 marker 指令（其标记在结构化解析里本就未被使用）。
  - `<suggestions>` 改为可定位的代码建议：每条针对具体代码的建议末尾带 `[file:…, lines:…]` 标记，解析层据此**逐条拆成 `code-suggestion` 卡**（带行号定位 + 编辑 / 拒绝 / 引用，可采纳为行内评论），非代码类建议仍为普通段落。

- 本地镜像缺 PR head sha 导致 diff / 评审失败且不自愈：源分支被删 / 强推（rebase / squash 常见）后，`refs/heads/*` 已看不到 PR 的 head sha，而 GitHub `refs/pull/<n>/head` / GitLab `refs/merge-requests/<n>/head` 默认不在 ref 广播里、通配 fetch 取不到 → `git diff base...head` 报 `Invalid symmetric difference`，此前只能手动删 bare 镜像目录重 clone（且删后对已删源分支仍救不回）。现 `ensureMirrorReadyForPr` 在常规 sync 后若 head sha 仍缺失，**按平台 + PR 号精确 fetch 该 PR 的头引用**（新增 `repoMirror.fetchRefspecs` + `pullRequestHeadRefspec`）把 head sha 钉回本地，自动恢复 diff / blame / pr-agent worktree（worktree 路径也改走同一 ensure 自愈）。Bitbucket 经既有通配 PR 引用本就覆盖。

- Monaco 控制台噪音报错治理：只读 diff + 着色用不到的 typescript/javascript · json · css · html 语言服务从源头关闭（对各 `*Defaults` 传空 `ModeConfiguration`，不注册任何 provider），消除其向未注册 worker 发 RPC 抛出的 `Missing requestHandler or method: …`（`getNavigationTree` / `getSyntacticDiagnostics` 等整族）；着色走 tokenizer 不受影响。剩余 Monaco 上游已知竞态（`TextModel got disposed before DiffEditorWidget model got reset`）作为已知问题默认静默，需诊断时 `localStorage.setItem('meebox.monacoDebug','1')` 再刷新可看明细——仅命中白名单消息，其它异常照常抛出。
- PR 头部与详情页的评审状态 chip（pending / approved / needs_work、reviewer 的 approved / needs work / pending）此前为写死英文，现按界面语言出国际化文案（新增 `prStatus` 文案集，四语言）。
- 切换不同 PR 时 diff 文件树「左栏空白 → 文件树整体弹出」的抖动：DiffView 改为 stale-while-loading——引入 `loadedPrId` 标记当前已渲染内容所属 PR，切 PR 期间保留旧树 / 旧内容渲染、上盖加载遮罩（延迟 150ms，命中缓存的快切换直接换新），并门控 content / comments / blame 拉取（避免「新 localId + 旧选中文件」错拉），新文件列表 ready 后整体替换。
- diff 文件树首次加载时文件名被图标渲染推移的抖动：图标改用固定 16px 占位槽包裹，iconify 的 svg 晚一帧进 DOM 也不塌缩，文件名位置稳定。
- 切换不同 PR 时评论页先闪「加载评论中」再渲新内容的空窗：改为 stale-while-loading——切 PR 期间保留旧评论渲染、上盖加载遮罩，新数据 ready 后整体替换；遮罩延迟 150ms 显示，命中本地缓存的快切换直接换新、零闪。
- PR 主面板 tab 栏角标（评论 / 提交计数）异步加载导致的抖动：计数加载中渲染等宽占位 chip 预留宽度，消除计数到达时的横向弹簧拉伸；`.pr-tab` 改 flex 布局 + 固定行高，角标占位 / 出现 / 消失不再改变 tab 高度，消除 tab 栏 1~2px 竖向跳动。
- PR 主面板各 tab（diff / 评论 / 草稿 / 提交 / 信息）切换抖动：此前 tab 内容按条件渲染，每次切换旧面板卸载、新面板重挂 → 重新拉数据、闪「加载中」、内嵌 Monaco 重建。改为 keep-alive——tab 首访才挂载（保留懒加载）、之后保活仅 CSS 显隐不卸载，切走再切回瞬时、无重拉、滚动位置与展开态保留；配合 Monaco `automaticLayout` 处理显隐后的重排。
- 刷新（后台轮询 / 窗口聚焦）时编辑器渲染抖动：评论页内嵌代码片段（Monaco）与 diff 编辑器此前每次刷新都重渲染 / 重建。根因有二——其一，i18n 语言切换 effect 依赖整个 boot 对象，poll 刷新 setBoot 后对同一语言反复 `changeLanguage`，触发 `languageChanged` 致所有 `useTranslation` 的 `t` 换新引用，凡 effect 依赖 `t` 的组件（如内嵌代码片段抓取逻辑）都被无谓重跑、连带 Monaco 卸载重建；其二，DiffEditor 的 `options` 为渲染期新建对象，被 `@monaco-editor/react` 按引用判变而反复 `updateOptions`。现语言 effect 仅在语言真正变化时切换、DiffEditor options 稳定化，刷新不再抖动。
- PR 详情页与评论页排版：正文限宽 960px 并居中，滚动条回到外层容器右缘（此前 max-width 加在滚动容器上，滚动条停在中部）；详情页 reviewers 列表按字典序固定排序，刷新不再随平台返回顺序抖动。
- 拉取变更文件列表偶发失败（`ENOENT … diff-base.json`）：状态存储对同一 key 的并发写共用同一临时文件，先完成者 rename 后，后完成者 rename 即 ENOENT。临时文件名追加进程内自增序号去重，并发写各用独立临时文件。Windows 上并发写同一 key 还会撞 `fs.rename` 覆盖既有文件的瞬时 EPERM/EACCES/EBUSY（打开 / 切换 PR 时多 handler 同写 diff-base.json）→ rename 加退避重试自愈（并打 warn 定位日志），同时对 diff-base 解析按 PR 去重、从源头收敛并发写。
- Agent 评审 / 规划步骤行的固定文案（如「判断是否存在需追问的严重问题」「严重，追问 N 个」）此前在 `@meebox/agent` 层写死中文、被渲染层逐字显示，日 / 英 / 德界面下漏出中文；现按会话语言落地（zh-CN / en-US / ja-JP / de-DE，缺省回落英文），与评审总结骨架同策略。
- 设置页手动「检查更新」查到的新版此前不同步到状态栏、也不缓存：手动检查只把结果回给设置页本地，与定时检查各自为政、无共享。现 main 侧统一为单一真相源——手动 / 定时检查都缓存结果并在有新版时广播 `app:updateAvailable`，状态栏即时出现升级 chip；新增只读 `app:getUpdateStatus`，窗口 / 状态栏挂载时水合已知结果，不因重挂载而丢失。
- 合并已合并 / 已关闭的 PR 报错不友好：Bitbucket 对已合并 PR 的合并请求回 409 + `IllegalPullRequestStateException`（本地状态滞后于远端：他人已合 / 重复点击），此前把原始 409 stack 抛给用户。归一为错误码 `EPR0003`，前端按码做 i18n 友好提示（四语言对等）；其它 409（冲突 / veto）原样冒泡。
- 评审总结被截断 / 无法解析（回落「无法解析建议」）：原把整段 markdown 总结塞进 JSON 字符串字段，正文里的引号 / 换行 / 代码块会破坏 JSON 解析，回退打捞时又在首个内层引号处把正文腰斩、且判定一并丢失 → 回落 manual_review。改为模型直接输出纯 markdown 正文 + 末尾一行扁平判定 JSON，正文走 `stripTrailingJson`（含对被截断 dangling 判定 JSON 的兜底剥除）、判定走新增 `extractTrailingJson` 单独解析（兼容旧嵌套格式），并给收尾 chat 显式输出 token 上限避免被 provider 默认上限截断。

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
