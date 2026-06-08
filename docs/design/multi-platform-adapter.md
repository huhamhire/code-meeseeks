# 多代码平台适配 —— 抽象设计与 GitHub / GitLab 差异评估

> 设计/评估文档（roadmap「多代码平台适配」）。现状见 [模块 01 · 代码平台适配](../modules/01-platform-adapter.md)。
> 目标：在不动业务层（轮询 / 镜像 / 评审发布）的前提下，把 GitHub、GitLab 接进同一 `PlatformAdapter`，
> 并提前识别各平台 API 能力差异、确定抽象需要的调整与无法抹平的缺口。

## 1. 现状与目标

当前 `PlatformAdapter`（[packages/shared/src/platform.ts](../../packages/shared/src/platform.ts)）已是干净的接缝：连接探测、PR 发现、
评论读写、合并、克隆 URL、头像 / 附件，业务层只依赖它。新增平台 = 新增一个实现 + 在
[adapters.ts](../../apps/desktop/src/main/adapters.ts) 的 `switch` 加 case。

难点不在「再写一个实现」，而在 **三家平台对同一概念的模型差异**：评论体系、行内锚点、审批语义、
可合并判定、发现端点与限流。本文逐项评估并给出抽象层需要的最小改动 + 必须暴露给 UI 的能力差异。

平台对象命名对齐（统一映射进 `PrIdentity{platform, group, repo, remoteId, connectionId}`）：

| 中性概念 | Bitbucket Server | GitHub | GitLab |
| --- | --- | --- | --- |
| group | projectKey | owner（org/user） | namespace（含子组） |
| repo | repoSlug | repo | project path |
| PR 标识 remoteId | PR id | PR number | MR **iid**（项目内编号，非全局 id） |
| PR 概念 | Pull Request | Pull Request | Merge Request |
| API base | 自建 `/rest/api/1.0` | github.com `/api/v3`；GHE Server 自建 | gitlab.com `/api/v4`；自建 |

> 企业内网场景里 GitHub = GitHub Enterprise Server、GitLab = 自建（CE/EE）居多，**自建实例的版本 / 套餐差异**
> （尤其 GitLab CE vs Premium）直接决定可用能力，见 §4.4。

## 2. 能力差异总览矩阵

| 能力 | Bitbucket Server | GitHub | GitLab |
| --- | --- | --- | --- |
| 认证 | PAT `Authorization: Bearer` | PAT `Authorization: Bearer`（classic / fine-grained） | PAT `PRIVATE-TOKEN` 或 `Authorization: Bearer` |
| Reviewer 待办发现 | dashboard 聚合端点（跨仓一次拿全） | Search API `review-requested:@me`（**30 次/分限流** + 最终一致） | `/merge_requests?scope=all&reviewer_username=`（全局、干净） |
| 评论模型 | 单一评论树（inline+summary），嵌套 reply | **分裂**：issue 评论（summary）+ review 评论（inline）+ reviews（决断） | notes + **discussions**（inline 在 discussion 的 position 里） |
| 评论乐观锁 | 有（`version`，删改必带） | 无 | 无 |
| 行内锚点输入 | `anchor{path,line,lineType,fileType}`+multilineMarker | `path,line,side,start_line` + **commit_id(head sha)** | `position{base_sha,start_sha,head_sha,old_path,new_path,old_line/new_line,line_range}` |
| 多行行内评论 | multilineMarker | `start_line/start_side` | `line_range` |
| 审批：通过 | reviewer status=APPROVED（幂等可撤） | review event=APPROVE（事件叠加，撤=dismiss） | `POST .../approve` —— **Premium-only API** |
| 审批：需修改 | NEEDS_WORK | review event=REQUEST_CHANGES | **无干净对应**（reviewer 状态 API 弱） |
| 审批：撤销 | UNAPPROVED | dismiss review | `POST .../unapprove` —— Premium-only |
| 可合并 + 否决项 | `/merge` 一次给 canMerge/conflicted/vetoes | `mergeable`/`mergeable_state`（异步算）+ 需自行拼检查/必评 | `detailed_merge_status`（**丰富枚举**，最接近 vetoes） |
| 合并 | `/merge?version=` | `PUT .../merge`（method） | `PUT .../merge` |
| 提交列表 | newest-first | oldest-first（需反转） | newest-first |
| 头像 | 经 PAT 取私有资源 | `avatar_url`（CDN，多为公开） | `avatar_url`（实例 URL，私有需鉴权） |
| 内嵌附件 | `attachment:HASH` 协议 | `user-attachments/...`（私有需鉴权） | `/uploads/<hash>/...`（私有需鉴权） |
| 草稿 PR | 无原生 | `draft` 布尔 | 标题 `Draft:` / `draft` 字段 |
| 分页 | `start/limit` + `isLastPage` | `Link` 头 `rel=next`，`per_page≤100` | `Link` 头 / `X-Total-Pages`；大表 keyset |

## 3. 抽象设计

### 3.1 接缝保持，新增「能力描述符」

`PlatformAdapter` 接口主体不变（已足够通用）。**新增 `capabilities()`**，把无法在所有平台等价实现的能力显式声明出来，
让 UI 据此灰显/禁用按钮、让业务层据此调整策略，而不是在调用处 try/catch 猜：

```ts
interface PlatformCapabilities {
  /** 支持的 review 决断（GitLab CE 可能只有 [] 或 ['approved']） */
  reviewStatuses: ReadonlyArray<'approved' | 'needsWork' | 'unapproved'>;
  inlineComments: boolean;          // 是否支持行内评论
  inlineMultiline: boolean;         // 多行行内评论
  commentOptimisticLock: boolean;   // 删改是否需要 version（仅 BBS）
  mergeVetoFidelity: 'full' | 'partial'; // 否决项是否逐条可得（BBS/GitLab full，GitHub partial）
  discoveryRateLimited: boolean;    // 发现端点是否强限流（GitHub search）→ 拉长轮询
}
```

### 3.2 数据模型调整（platform.ts）

- `PrComment.version?` → 保持**可选**，明确为 BBS 专属乐观锁；GH/GL 忽略。
- `PrComment` 增补：`kind?: 'summary' | 'inline'`、`threadId?: string`（GH review-comment 的 `in_reply_to`/GL discussion id），
  `nativeId`（回写幂等）。GH/GL 的「评论树」由 adapter **合并多个端点**后组装成现有嵌套结构，业务层无感。
- 行内发布需要 diff 基准 sha：新增中性 `PrDiffRefs { headSha: string; baseSha: string; startSha?: string }`。
  - 来源：我们本地镜像算 diff，PR meta 已有 head/base sha（见 [模块 02](../modules/02-repo-mirror.md)）。
  - `publishInlineComment` 签名增补一个 `refs: PrDiffRefs`（或在 adapter 内按 prId 拉 PR 取 `diff_refs`）。
    - GitHub 用 `headSha` 作 `commit_id`；GitLab 用三 sha 拼 `position`；BBS 不需要（忽略）。
- `MergeStatus.vetoes` 语义不变，但**保真度分级**（见 capabilities.mergeVetoFidelity）：GitHub 只能给近似项。
- `PrIdentity` 不变；GitLab adapter 内部另存 project 数字 id（iid 是项目内编号，API 调用要项目 id + iid）。

### 3.3 客户端层

- 认证头按平台注入（BBS/GitHub Bearer；GitLab PRIVATE-TOKEN 或 Bearer），沿用现有「可注入 fetch」挂代理。
- **分页适配器**：BBS `start/limit` 与 GitHub/GitLab `Link` 头两种风格，封装成统一异步迭代器（不进 `PlatformAdapter` 接口）。
- 限流：GitHub search 30/分 → 发现轮询间隔对该平台单独抬高（capabilities.discoveryRateLimited 驱动）。

### 3.4 Diff 仍走本地 git

三家都有 diff 端点但都会对大 PR 截断；继续用本地镜像算 diff，**与平台解耦**，仅在「行内评论发布」时用平台锚点。
这条现状决策对多平台同样成立，是抽象能简化的关键。

## 4. 逐能力差异详解

### 4.1 PR 发现（reviewer 待办）

- **GitHub**：无 dashboard，靠 Search `GET /search/issues?q=is:open+is:pr+review-requested:@me+archived:false`。
  代价：搜索限流 30/分、结果最终一致（刚请求评审可能短暂查不到）、返回是 issue 形态需再取 PR 详情。
- **GitLab**：`GET /merge_requests?scope=all&state=opened&reviewer_username=<me>` 全局跨项目，干净直接（最接近 BBS dashboard）。
- 抽象：`listPendingPullRequests()` 保持；但**「待我评审」的定义各平台不同**（GitHub review-requested vs GitLab reviewer
  vs 旧 assignee 模型），需在各 adapter 内固定语义并在文档写清。

### 4.2 评论体系（最大分歧）

- **BBS**：一棵评论树，inline（带 anchor）与 summary（anchor=null）同源，reply 嵌套，删改带 `version`。
- **GitHub**：三套概念 ——
  - issue 评论 `/issues/{n}/comments` = PR 级讨论（≈ summary，无线程）；
  - review 评论 `/pulls/{n}/comments` = 行内（含 `path/line/side/start_line/in_reply_to_id/commit_id/diff_hunk`）；
  - reviews `/pulls/{n}/reviews` = 决断 + 可带成组行内评论。
  - 组装：adapter 把 issue 评论作 summary、review 评论按 `in_reply_to_id` 还原成线程，统一成现有 `PrComment[]`。
- **GitLab**：notes + discussions。inline = 带 `position` 的 discussion；reply = 往 discussion 追加 note；需**过滤 system note**。
- 影响：`version` 仅 BBS；GH/GL 的 `canEdit/canDelete` 用「作者==当前用户」判定即可（无锁）。回复目标：BBS 用父评论 id、
  GitHub 用 review-comment id（`/replies`）、GitLab 用 discussion id —— 用 `threadId` 抽象。

### 4.3 行内评论锚点（最难对齐）

内部锚点是 `(path, startLine, endLine, side)`（目标分支视角）。落平台：

- **GitHub**：`POST /pulls/{n}/comments` { body, **commit_id=head sha**, path, line, side(LEFT=old/RIGHT=new), start_line?, start_side? }。
  行号必须落在该 commit 的 diff 内，否则 422。
- **GitLab**：`POST .../discussions` { body, position:{ position_type:'text', base_sha,start_sha,head_sha, old_path,new_path,
  new_line（加/上下文行）| old_line（删除行）, line_range（多行） } }。三 sha 取自 MR `diff_refs`。
- **BBS**：`anchor{path,line,lineType(added/removed/context),fileType,srcPath}` + multilineMarker（现状）。
- 抽象：把 `side`（old/new）+ 行角色 + `PrDiffRefs` 喂给 adapter，由各自拼平台锚点。**我们本地算 diff 时已知每行的
  added/removed/context 角色与新旧行号**，正是三家都需要的输入 —— 这是抽象能成立的基础。

### 4.4 审批决断（能力缺口最明显）

- **BBS**：reviewer status 三态（APPROVED/NEEDS_WORK/UNAPPROVED），幂等、可来回切，完美匹配现有 `setPullRequestReviewStatus`。
- **GitHub**：review 是**追加事件**。approved→`POST /reviews{event:APPROVE}`；needsWork→`{event:REQUEST_CHANGES}`；
  撤销→`PUT /reviews/{id}/dismissals`。注意：**不能审批自己的 PR**（422）；「当前状态」取该用户最近一条 review。
- **GitLab**：`approve`/`unapprove` 端点 **13.9 起为 Premium**（Free/CE 自建用不了 API 审批）；**needsWork 无干净对应**
  （reviewer「requested_changes」状态 API 支持弱）。
- 结论：用 `capabilities.reviewStatuses` 暴露真实能力 ——
  - BBS：`['approved','needsWork','unapproved']`
  - GitHub：`['approved','needsWork','unapproved']`（needsWork=REQUEST_CHANGES）
  - GitLab Premium：`['approved','unapproved']`；GitLab CE：`[]`（按需降级为「只发评论 + 不解决 discussion」的弱替代，并在 UI 灰显「通过/需修改」）。

### 4.5 合并与可合并判定

- **BBS**：`/merge` 一次给 `canMerge/conflicted/vetoes`，最省事。
- **GitHub**：PR 的 `mergeable`（bool|null，**异步计算**，初次可能 null 需轮询）+ `mergeable_state`
  （clean/dirty/blocked/behind/unstable/draft）。逐条否决项要再查分支保护 + check-runs/status + 必评 → 只能给**近似 vetoes**
  （fidelity=partial）。合并 `PUT .../merge{merge_method}`。
- **GitLab**：`detailed_merge_status` 枚举丰富（`conflict / ci_must_pass / discussions_not_resolved / not_approved /
  status_checks_must_pass / draft_status …`）→ 直接映射成逐条 vetoes（fidelity=full）。合并 `PUT .../merge`。
- 抽象：`MergeStatus` 不变；GitHub 实现需多打几个端点拼装且容忍 `mergeable=null`（轮询/兜底）。

### 4.6 其它

- **提交排序**：GitHub oldest-first → adapter 反转成 newest-first（契约要求）；GitLab/BBS 本就 newest-first。
- **头像 / 附件**：GH/GL 头像多为可直取 URL（私有实例可能需鉴权）；内嵌附件协议三家不同
  （BBS `attachment:HASH`、GitHub `user-attachments`、GitLab `/uploads/`），私有资源都要经 main 端带凭据代理（沿用 `getAttachment`）。
- **草稿**：GitHub `draft`、GitLab 标题 `Draft:`/字段；映射到现有 `PullRequest.draft`。

## 5. 抽象需要的改动清单（落地项）

1. `PlatformAdapter` 增 `capabilities(): PlatformCapabilities`；UI 据此灰显不支持的决断/行内能力。
2. `platform.ts` 类型：`PrComment` 增 `kind?/threadId?/nativeId?`；`version?` 明确 BBS 专属；新增 `PrDiffRefs`；
   `publishInlineComment` 接 `refs`（或 adapter 内拉取）。
3. `replyToComment` 的 `parentCommentId` 语义放宽为 `threadId`（BBS 父评论 / GitHub review-comment / GitLab discussion）。
4. 客户端：认证头按平台、`Link` 头分页迭代器、按平台调发现轮询间隔（GitHub search 限流）。
5. `setPullRequestReviewStatus`：各平台按 capabilities 实现；不支持的态返回明确「unsupported」而非静默失败
   （配合已加的操作失败 toast）。
6. `mergeStatus` 拼装：GitLab 走 `detailed_merge_status`；GitHub 拼 `mergeable_state`+检查+必评，标 fidelity=partial。
7. **adapter 一致性测试套件**（contract tests）：对每个 adapter 跑同一组用例（发现/评论往返/行内锚点/合并判定/决断），
   新平台接入前先过套件。

## 6. 风险与无法抹平的缺口

- **GitLab CE 无 API 审批**（approve/unapprove Premium-only）、needsWork 无对应 → 这是产品级缺口，只能 UI 降级 + 文档说明，
  不能在抽象层假装支持。
- **GitHub Search 限流 + 最终一致** → 发现不能像 BBS 那样高频；需独立轮询节流 + 「刚被请求评审可能延迟出现」的预期管理。
- **GitHub mergeable 异步 null** → 首次打开 PR 可能拿不到可合并判定，需轮询或延迟展示，不能当 false。
- **行内锚点 422/400 风险**：三家都要求锚点行真实落在 diff 内；我们本地 diff 与平台 diff 若有差异（如平台对超大 diff 截断、
  rename 处理）可能发布失败 —— 需要发布失败的逐条回退（现已有）+ 锚点角色严格取自本地 diff。
- **自建实例版本碎片化**：GHE Server / GitLab 自建版本跨度大，端点/字段可用性需 `ping()` 时探测版本并按能力降级。

## 7. 实施建议（分期）

1. **抽象先行**：落 §5 的类型 + `capabilities` + contract 测试套件（用 BBS 现有实现跑通，确立基线）。
2. **GitHub 优先**。综合「实现代价 + 功能完整度」对本产品（reviewer 决策权在人）更划算：
   - **审批闭环既便宜又完整**：`APPROVE / REQUEST_CHANGES / dismiss` 干净映射 approved/needsWork/unapproved；
     GitLab 反而是硬伤（approve API 为 Premium、needsWork 无对应，CE 实例审批走不通，还要做 edition 探测 + 降级）。
   - **无版本 / 套餐门槛**：github.com 与 GHE Server 同一套 API、能力一致，省掉一整个「探测 + 分能力位」维度。
   - GitHub 多出来的活（评论三分归一、search 30/分限流、`mergeable` 异步 null）都是**机械、有界、有成熟先例**，
     非架构难点：轮询型客户端 5 分钟一轮远低于限流；mergeable null 轮询兜底即可。
3. **GitLab 第二**：发现端点干净、`detailed_merge_status` 丰富是其优势；但接入重点是 **edition 探测 + 审批降级（§9）**——
   企业自建 EE/Premium 才有完整审批，CE 实例审批位降级。
4. 每接一个平台：先过 contract 套件，再开 UI 灰显（capabilities 驱动）。

> 落地改造计划见 [GitHub 适配改造计划](./github-adapter-plan.md)。

## 8. 评论交互：统一模型 + 能力位

结论：**不按平台分设计评论标签页**，而是一套交互模型，差异收敛成「能力位」。短期看「分平台」省事，长期在
维护（×N 组件/测试）、用户心智（跨平台重学）、以及把平台概念漏进 UI（破坏 §3 接缝）上都是亏的。

### 8.1 统一模型

- 渲染层只消费**中性 `PrComment` 树** + `capabilities()`；核心动作（读 / 回复 / 编辑 / 删除 / 草稿→确认发布）三家一致。
- 各平台评论概念由 **adapter 归一**成同一棵嵌套结构（BBS 单树；GitHub issue 评论 + review 评论 + reviews；
  GitLab notes + discussions）——见 §4.2。**归一可行 = 不该分叉**；只有当某平台模型无法被 `PrComment` 无损表达时，
  才是重新评估「专门组件」的真实信号（当前三家都能归一）。

### 8.2 能力位（扩展 §3.1 的 `PlatformCapabilities`，面向评论 UI）

| 能力位 | 含义 | 谁有 |
| --- | --- | --- |
| `resolvableThreads` | 线程可「解决 / Resolve」+ 折叠已解决 | GitHub conversation / GitLab discussion；**BBS 无** |
| `suggestions` | 行内代码建议可「一键应用」 | GitHub / GitLab；**BBS 无** |
| `reviewGrouping` | 决断 + 行内评论**成组提交**（pending review） | GitHub reviews / GitLab 批量 |
| `commentOptimisticLock` | 删改需带 `version` | **仅 BBS**（adapter 内部消化，UI 无感） |

> `reviewGrouping` 不引入新范式：直接复用产品现有的**「本地草稿池 → 批量发布」**闭环（见 [模块 05](../modules/05-review-workflow.md)），
> 三平台共用同一「先攒草稿、再一次性提交」的心智。

### 8.3 能力位 → UI 表现

| 能力位 | 为真 | 为假（降级，见 §9） |
| --- | --- | --- |
| `resolvableThreads` | 线程头出「解决/重开」按钮、已解决折叠 | 隐藏按钮与折叠态 |
| `suggestions` | suggestion 块 + 「应用」入口 | 仅按普通评论展示其文本，隐藏「应用」 |
| `reviewGrouping` | 草稿池批量提交时附决断 | 决断与发布分开（仍走草稿池，不绑组） |
| `commentOptimisticLock` | 删改透传 version | 不带 version（GH/GL 无锁） |

### 8.4 划线原则（与 §3 一致）

渲染层只对**能力位**分支，**绝不对 `platform` kind 分支**：`if (caps.resolvableThreads)` ✅ /
`if (platform === 'github')` ❌。新平台只在 adapter 声明能力位，评论页自动适配、不支持的按 §9 优雅降级。

## 9. 功能降级设计（能力不可用时）

API 能力受限、某功能在某平台/版本/权限下无法实现时，**不静默吞掉、也不报错崩**，而是按能力优雅降级。
评论标签页等交互沿用「单一模型 + 能力驱动」（见 §3.1、§8），UI 只读 `capabilities()` 与 PR 状态分支，**绝不写 `platform` kind**。

### 9.1 三种降级方式与选择规则

| 方式 | 用在何时 | 例 |
| --- | --- | --- |
| **置灰 + 原因 tooltip**（disabled） | 用户**预期存在**、但因平台版本 / 权限暂不可用 → 保留可发现性并说明原因 | GitLab CE 的「通过」（需 Premium）；无合并权限 |
| **隐藏不渲染** | 平台**概念上根本没有**该能力 → 常驻置灰只是噪音 | BBS 无「解决线程」概念；不支持 suggestion 的平台不出「应用」入口 |
| **降级替代（fallback）** | 有可用的弱替代动作 | GitLab CE「需修改」无 API → 退化为「发评论 + 不解决讨论」并提示 |

一句话判据：**「本可有但此实例没有」→ 置灰说明；「平台无此概念」→ 隐藏；「有弱替代」→ 替代 + 提示。**

### 9.2 能力来源分两层

- **静态能力（平台 / 版本 / 套餐）**：来自 `capabilities()` → 决定 feature 级的 **显 / 隐 / 灰**（接入即固定，如 GitLab CE 审批位）。
- **动态状态（本 PR / 本用户权限 / 异步未就绪）**：来自 PR 数据 → 决定 instance 级的 **灰 + 原因**
  （沿用现状：合并按钮仅 `mergeStatus.canMerge` 时出现）。

### 9.3 文案要说清「为什么」和「去哪做」

- 版本门槛：「需 GitLab Premium；可在网页端审批」
- 权限不足：「当前账号无合并权限」
- 异步未就绪（GitHub `mergeable=null`）：中性 loading 态，**不是永久置灰**，拿到结果再定
- 概念缺失：直接不显示，不留空壳

### 9.4 逐能力降级映射

| 能力 | 不可用场景 | 降级 |
| --- | --- | --- |
| 审批：通过 | GitLab CE（approve API 为 Premium） | 置灰 + 「需 Premium / 网页端」 |
| 审批：需修改 | GitLab（无干净对应） | 隐藏该按钮（或 fallback 为评论） |
| 行内 suggestion「应用」 | BBS / 不支持的平台 | 隐藏「应用」入口；suggestion 仍按普通评论展示文本 |
| 线程「解决 / Resolve」 | BBS（无此概念） | 隐藏 resolve 按钮与「已解决」折叠态 |
| 合并否决项逐条 | GitHub（partial 保真度） | 展示已知项 + 「可能还有其它检查未通过」泛化提示，不假装完整 |
| 合并 | 不满足 / 无权限 | 不满足：只读判定 + 否决原因；无权限：置灰 + 原因 |

### 9.5 实现约束

- 渲染层分支只认 `capabilities` 与 PR 状态，**不出现 `if (platform === ...)`**（守住 §3 接缝）。
- 置灰控件必须带 `title` / `aria-label` 说明原因（无障碍 + 可发现性）。
- 「不可用」**绝不做成点了没反应**——要么置灰/隐藏，要么明确失败提示（已有操作失败 toast 兜底）。
- `capabilities()` 是降级的唯一事实源：新平台只声明能力，UI 自动按上表 显/隐/灰，无需逐处改。

---

来源（GitLab 能力核实）：
- [Merge request approvals API | GitLab Docs](https://docs.gitlab.com/api/merge_request_approvals/)（approve/unapprove 13.9 起 Premium）
- [Merge requests API · detailed_merge_status | GitLab Docs](https://docs.gitlab.com/api/merge_requests/)
