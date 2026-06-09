# 01 · 代码平台适配

把「代码托管平台」的差异收口到一个统一抽象 `PlatformAdapter`，业务层（轮询、镜像、评审发布）
只依赖该接口、不感知具体平台。本章是平台适配的**统一设计与维护入口**：抽象实现、能力位与降级、
评论统一模型，以及各平台（Bitbucket / GitHub / GitLab）差异化适配逻辑。

已实现：**Bitbucket Server / Data Center**、**GitHub（github.com + GitHub Enterprise Server）**。
规划中：**GitLab**。不负责：git 本地操作（见 [02](02-repo-mirror.md)）、pr-agent 调用（见 [04](04-pragent-runtime.md)）。

---

## 1. 核心抽象设计

- **统一抽象 `PlatformAdapter`**（[packages/shared/src/platform.ts](../../packages/shared/src/platform.ts)）：一个接口覆盖
  能力描述、连接探测、PR 发现、评论读写、审批、合并、克隆 URL、头像 / 附件。新增平台＝新增一个实现 +
  在 [adapters.ts](../../apps/desktop/src/main/adapters.ts) 的 `switch` 加 case，业务层零改动。
- **平台中性的 PR 身份 `PrIdentity`**：`platform / group / repo / remoteId / connectionId`（+ 可选 url）。
  各平台把自己的概念映射进来；这套身份也是状态存储 hash localId 的输入（见 [03](03-state-storage.md)）。

  | 中性概念 | Bitbucket | GitHub | GitLab（规划） |
  | --- | --- | --- | --- |
  | group | projectKey | owner（org/user） | namespace |
  | repo | repoSlug | repo | project path |
  | remoteId | PR id | PR number | MR **iid**（项目内编号） |

- **认证只用 PAT**：`Authorization: Bearer <token>`（GitLab 亦可走此头）。token 经凭据层读取，绝不进日志。
- **REST 客户端可注入 fetch**：底层 HTTP 客户端暴露 `fetch` 注入口，用于挂代理 dispatcher（见 [08](08-networking-proxy.md)）
  与测试桩；默认用全局 fetch。分页按平台风格封装成异步迭代器（Bitbucket `start/limit`；GitHub/GitLab `Link` 头）。
- **Diff 不走 adapter 抓取**：平台 `/diff` 端点对大 PR 会 `truncated`；Diff 展示一律由本地镜像 `git` 算
  （见 [02](02-repo-mirror.md)），与平台解耦。**仅「发布行内评论」时用平台锚点**——本地算 diff 时已知每行
  新旧行号与 added/removed/context 角色，正是各平台锚点都需要的输入，这是抽象能成立的关键。
- **clone 协议二选一**：`pat`（默认，URL 里嵌 `<user>:<PAT>`）或 `ssh`（`git@host:...`，走系统 ssh 配置）。

### 接口与中性数据模型

`PlatformAdapter` 方法：

- 能力：`capabilities()`（静态能力描述符，见 §2）。
- 连接：`ping()`（版本 + 用户）、`getCurrentUser()`（同步读 ping 缓存，判 approved 用）。
- 发现：`listPendingPullRequests()`（reviewer 待处理，跨仓）。
- 读：`listPullRequestComments()`、`listPullRequestCommits()`（**newest-first**）、`getUserAvatar(slug)`、`getAttachment(url, repo?)`。
- 写：`setPullRequestReviewStatus()`、`mergePullRequest()`、`publishInlineComment()`、`replyToComment()`、`editComment()`、`deleteComment()`。
- git：`getCloneUrl(repo)`。

中性类型要点：

- `PrComment`：`anchor`（null=summary / 非空=inline）、`replies[]`、可选 `version`（**仅 Bitbucket 乐观锁**）、
  `kind`（'summary' | 'inline'）、`threadId`（回复目标抽象：Bitbucket=父评论 id / GitHub=review-comment id / GitLab=discussion id）。
- `PrCommentAnchor`：`(path, line, side('old'|'new'), lineType('added'|'removed'|'context'))`。
- `PrDiffRefs`：`{ headSha, baseSha, startSha? }`——行内评论发布锚点用（GitHub head sha / GitLab 三 sha；Bitbucket 忽略）。
- `MergeStatus`：`{ canMerge, conflicted, vetoes[] }`；保真度见 §2 的 `mergeVetoFidelity`。

---

## 2. 能力描述符与功能降级

无法在所有平台等价实现的能力，用 `capabilities()` 返回的 **`PlatformCapabilities`** 显式声明，
UI 据此 显/隐/灰，业务层据此调策略——**绝不在调用处 `try/catch` 猜，也不写 `if (platform === ...)`**。

`PlatformCapabilities` 字段：`reviewStatuses`（支持的审批决断）、`inlineComments`、`inlineMultiline`、
`commentOptimisticLock`、`mergeVetoFidelity`（'full' | 'partial'）、`discoveryRateLimited`、
`resolvableThreads`、`suggestions`、`reviewGrouping`。

各平台能力一览：

| 能力 | Bitbucket | GitHub | GitLab（规划） |
| --- | --- | --- | --- |
| reviewStatuses | 通过/需修改/撤销 | 通过/需修改/撤销 | Premium：通过/撤销；CE：无 API 审批 |
| commentOptimisticLock | 是（version） | 否 | 否 |
| mergeVetoFidelity | full（/merge vetoes） | partial（拼 mergeable_state） | full（detailed_merge_status） |
| discoveryRateLimited | 否 | 是（search 30/分） | 否 |
| resolvableThreads / suggestions | 否 / 否 | 概念有，当前未实现 | 概念有，当前未实现 |

### 功能降级三态与判据

- **置灰 + 原因 tooltip**：用户预期存在、但因平台版本 / 权限暂不可用 → 保留可发现性并说明原因。
- **隐藏不渲染**：平台概念上根本没有该能力。
- **降级替代**：有可用的弱替代动作。

判据：**「本可有但此实例没有」→ 置灰说明；「平台无此概念」→ 隐藏；「有弱替代」→ 替代 + 提示。**

两层能力来源：

- **静态**（平台/版本/套餐）← `capabilities()`：经 `ConnectionSummary.capabilities` 下发渲染层，决定 feature 级 显/隐/灰。
- **动态**（本 PR / 本用户权限 / 异步未就绪）← PR 数据：决定 instance 级 灰 + 原因（如合并按钮仅 `mergeStatus.canMerge` 时出现；
  GitHub `mergeable=null` 用「计算中」中性态而非永久置灰；自己作者的 PR 审批按钮灰显）。

---

## 3. 评论交互：统一模型 + 能力位

**不按平台分设计评论 UI**，而是一套交互模型，差异收敛成能力位。渲染层只消费中性 `PrComment` 树 +
`capabilities()`；各平台评论概念由 **adapter 归一**成同一棵嵌套结构。核心动作（读 / 回复 / 编辑 / 删除 /
草稿→确认发布）三家一致。**归一可行 = 不分叉**；只有当某平台模型无法被 `PrComment` 无损表达时，才重估「专门组件」。

能力位（面向评论 UI）：`resolvableThreads`（线程解决 + 折叠）、`suggestions`（行内建议一键应用）、
`reviewGrouping`（决断 + 行内评论成组提交，映射到本地「草稿池→批量发布」，见 [05](05-review-workflow.md)）、
`commentOptimisticLock`（删改是否带 version）。能力位为 false 时按 §2 降级（隐藏 / 置灰）。

---

## 4. 平台差异化适配

### 4.1 Bitbucket Server / Data Center（REST API v1，≥ 7.0）

- **发现**：dashboard 聚合端点 `/dashboard/pull-requests?role=REVIEWER&state=OPEN`，一次拿全跨项目跨仓库的待评审 PR。
- **当前用户**：每个鉴权请求响应头带 `X-AUSERNAME`（slug），ping 时据此 + `/users/{slug}` 取 displayName。
- **版本下限 7.0**：`ping()` 读 `application-properties` 版本，低于 7.0 拒绝（multilineMarker 等关键能力 7.0 起）。
- **评论**：走 `/activities` 拿全部活动，过滤 `COMMENTED` + `ADDED`；单棵评论树，reply 走 `comment.comments[]` 嵌套。
- **行内锚点**：`anchor{path, line, lineType(ADDED/REMOVED/CONTEXT), fileType(FROM/TO)}` + `diffType=EFFECTIVE`
  （锚到「当前生效 diff」，PR 后续 push 仍跟着行走）；多行用 multilineMarker。
- **乐观锁**：评论删 / 改必带 `version`（query / body），不一致回 409；删除带 reply 的评论被拒（409）。
- **审批**：`PUT …/participants/{userSlug}` 写 status（APPROVED / NEEDS_WORK / UNAPPROVED），幂等可来回切。
- **合并**：`/merge` 一次给 `canMerge / conflicted / vetoes`（full 保真）；`POST …/merge?version=N` 带乐观锁。
- **clone**：pat → `https://<user>:<PAT>@host/scm/<proj>/<repo>.git`（用户名取 cachedUser）；ssh → `git@host:<proj>/<repo>.git`（默认 7999 端口需 ssh config 配）。

### 4.2 GitHub（github.com + GitHub Enterprise Server，REST API v3）

> 以下是「代码本身讲不清」的核心逻辑，务必随实现一起维护。

- **Base URL 与 host 推导**：连接 base 是 **API base**（github.com→`https://api.github.com`；GHE→`https://<host>/api/v3`）。
  clone / 头像 / 网页用的 **web/git host** 由 adapter 推导：`api.github.com → github.com`；GHE → 同 host（去掉 `/api/v3`）。
- **发现（强限流 + 最终一致 + 两段取数）**：无 dashboard，用 Search `GET /search/issues?q=is:open is:pr review-requested:@me archived:false`。
  - search **约 30 次/分钟限流** → `capabilities.discoveryRateLimited=true`，该平台轮询间隔单独拉长。
  - search 返回的是 **issue 形态**（含 `repository_url` + `number`），需逐条再取 `GET /repos/{o}/{r}/pulls/{n}`（拿 head/base sha、
    mergeable、draft）+ `GET …/pulls/{n}/reviews`（算 reviewer 状态），并行 N+1。
  - 结果**最终一致**：刚被请求评审的 PR 可能短暂查不到——属预期，靠下一轮轮询补上。
- **评论三分体系归一**：GitHub 把评论拆三套 ——
  - issue 评论 `/issues/{n}/comments` = PR 级讨论（≈ summary，无线程）；
  - review 评论 `/pulls/{n}/comments` = 行内（带 `path/line/side/in_reply_to_id`）；
  - reviews `/pulls/{n}/reviews` = 决断。
  adapter 把 issue 评论作 summary、review 评论按 `in_reply_to_id` 还原成顶层 + 嵌套 reply，统一成 `PrComment` 树。
- **行内锚点需 head sha**：`POST …/pulls/{n}/comments` 必带 `commit_id`（= PR head sha）。按抽象决策，**adapter 内部
  先拉 PR 取 head sha** 再发，调用方无需改。side：内部 'old'→`LEFT` / 'new'→`RIGHT`。行号须落在该 commit 的 diff 内，否则 422。
- **审批是追加事件**：通过→`POST …/reviews{event:APPROVE}`；需修改→`{event:REQUEST_CHANGES, body}`（GitHub 要求带 body）；
  撤销→找当前用户最近一条 APPROVED/CHANGES_REQUESTED review，`PUT …/reviews/{id}/dismissals`。
  **不能审批自己的 PR**（422）→ UI 对自己作者的 PR 灰显审批按钮。「当前状态」取该用户最近一条决断性 review。
- **评论删 / 改 / 回复无 version**：先按 inline（`/pulls/comments/{id}` 改删、`/pulls/{n}/comments/{id}/replies` 回复），
  404/422 退化为 issue 评论端点（`/issues/comments/{id}`、新建 issue 评论）。
- **合并与可合并（partial）**：`mergeable`（bool|**null**，异步计算，初次可能 null）+ `mergeable_state`
  （clean/dirty/blocked/behind/unstable）。逐条否决项无单一端点，由 adapter 按 `mergeable_state` **派生近似**
  （fidelity=partial）；`null` 不当 false，标「计算中」。合并 `PUT …/pulls/{n}/merge`。
- **提交**：`/pulls/{n}/commits` 为 oldest-first，adapter **反转**为 newest-first。
- **头像 / 附件**：头像直链 `<webBase>/<login>.png`；评论内嵌图片是绝对 URL（user-attachments / githubusercontent / GHE host），
  经 main 端带 PAT 代理拉（私有需鉴权）。
- **Token 权限**：见 [代码平台配置 · GitHub PAT 权限参考](../guide/01-code-platform.md)（经典 `repo`；细粒度 Pull requests RW + Contents RW + Metadata R）。

### 4.3 GitLab（规划中）

- 发现端点干净：`GET /merge_requests?scope=all&state=opened&reviewer_username=<me>`（全局跨项目）。
- 评论 = notes + discussions（inline 在 discussion 的 `position` 里，需 base/start/head 三 sha；过滤 system note）。
- 可合并：`detailed_merge_status` 枚举丰富（full 保真）。
- **缺口**：approve/unapprove API **自 13.9 起为 Premium**，CE 实例无 API 审批；needsWork 无干净对应 →
  `capabilities.reviewStatuses` 据 edition 降级（Premium：通过/撤销；CE：空 + UI 灰显）。接入时重点是 edition 探测 + 降级。

---

## 5. 扩展与注意事项

- **加新平台**：实现 `PlatformAdapter`（含 `capabilities()`）+ `PrIdentity` 映射 + adapters.ts case + config schema
  （discriminatedUnion）+ 配置 UI 放开平台选项。建议先用 Bitbucket 跑通一套 **adapter 契约测试**作基线，新平台过套件再开。
- **能力位驱动 UI**：审批/合并/评论交互一律读 `capabilities` + PR 状态分支，**不出现 `if (platform === ...)`**（守住接缝）。
- **写路径有副作用**：合并不可逆；评论发布要幂等（成功落远端 id 防重发，见 [05](05-review-workflow.md)）；
  审批 / 合并远端失败要给用户明确提示（toast），不可静默。
- **作者字段双名**：展示名（中文/真名）与登录名（英文 id）分清——展示用前者，匹配「当前用户 / 是否自己的 PR」用后者。
- **后续未尽项**：评论「解决线程 / suggestion 应用」UI（能力位已留位，未实现）；GitLab 接入；真实 GHE/github.com 端到端联调。
