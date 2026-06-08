# GitHub 适配改造计划

> 落地计划，承接 [多平台适配抽象设计](./multi-platform-adapter.md)（§5 类型改造、§8 评论能力位、§9 降级）。
> 目标：在不破坏现有 Bitbucket 路径的前提下，接入 **GitHub（github.com + GitHub Enterprise Server）**，
> 跑通「发现 → 读 diff/评论 → /review → 草稿确认发布 → 审批 → 合并」完整闭环。
> 工作流：全部在 `dev` 上分阶段提交，每阶段可独立验证；未确认不发布。

## 0. 现状锚点（已核对）

- 抽象接口：[packages/shared/src/platform.ts](../../packages/shared/src/platform.ts)（`PlatformAdapter` + 中性类型；`PlatformKind` 已含 `'github'`）。
- 配置：[packages/shared/src/config.ts](../../packages/shared/src/config.ts) `ConnectionSchema = discriminatedUnion('kind', [BitbucketServerConnectionSchema])`。
- 接线：[apps/desktop/src/main/adapters.ts](../../apps/desktop/src/main/adapters.ts) `buildAdapters` / `buildDraftAdapter`（switch on kind）。
- 参考实现：`@meebox/platform-bitbucket-server`（`src/{adapter,client,index}.ts` + `tests/adapter.test.ts`）。
- 连接测试：`config:testConnection` → `buildDraftAdapter`（[ipc.ts](../../apps/desktop/src/main/ipc.ts) 1495）。
- 平台图标：[PlatformIcon.tsx](../../apps/desktop/src/renderer/src/components/PlatformIcon.tsx) 现把 GitHub 置灰（`available:false`）。

## 阶段拆分

### Phase 0 · 抽象基线（不接平台，先补接缝 + 用 Bitbucket 验证）

- [x] `platform.ts`：新增 `PlatformCapabilities`（`reviewStatuses / inlineComments / inlineMultiline /
      commentOptimisticLock / mergeVetoFidelity / discoveryRateLimited / resolvableThreads / suggestions /
      reviewGrouping`）；`PlatformAdapter` 增 `capabilities(): PlatformCapabilities`。
- [x] `platform.ts`：新增 `PrDiffRefs { headSha; baseSha; startSha? }`；`PrComment` 增 `kind? / threadId? / nativeId?`
      （`version?` 维持可选，标注 Bitbucket 专属）。
- [ ] `publishInlineComment`：定为「adapter 内部按 prId 拉 PR 取 diff refs」（GitHub head sha / GitLab diff_refs），
      避免改所有调用方；Bitbucket 实现忽略。（备选：调用方传 `PrDiffRefs`，churn 更大，不选。）
      —— 方案已定（`PrDiffRefs` 类型就位）；具体取数留到建 GitHub adapter 时落地。
- [x] Bitbucket adapter 实现 `capabilities()`（全能力：三态审批、inline 多行、乐观锁、veto full、resolvable/suggestions=false、
      reviewGrouping=false），**行为零变化**。
- [x] 能力下发渲染层：`ConnectionSummary`（`app:connections`）增 `capabilities`（main 端从 adapter 取）。
      UI 按 `pr.connectionId → capabilities` 的门控放到 Phase 4。
- [ ] **contract 测试套件**：抽一组「接口契约」用例（评论往返 / inline 锚点 / 合并判定 / 审批 / 提交 newest-first），
      先用 Bitbucket（fixtures / 录制）跑通，作为后续 GitHub 的验收基线。

> Phase 0 进度（截至当前）：抽象类型 + `capabilities()` + Bitbucket 实现 + 能力下发已落地，
> typecheck / test / lint 全绿；附带把全仓 `BBS / BB*` 缩写统一为 `Bitbucket`。剩 `publishInlineComment`
> 取数（随 GitHub adapter）与 contract 测试套件。

### Phase 1 · 配置 + 接线（让 `'github'` kind 可配、可建 adapter）

- [ ] `config.ts`：新增 `GitHubConnectionSchema`（`kind:'github'`、`base_url`（github.com 默认 `https://api.github.com`，
      GHE 填实例 API base）、`auth.pat`、`clone.protocol`）；`ConnectionSchema` discriminatedUnion 加入它。
- [ ] 新建包 `@meebox/platform-github`（镜像 Bitbucket 包结构 `src/{adapter,client,index}.ts` + `tests/`）。
- [ ] `adapters.ts`：`buildAdapters` / `buildDraftAdapter` 加 `case 'github'`（穷尽 switch 的 `never` 守卫保留）。
- [ ] 配置 UI：[PlatformIcon.tsx](../../apps/desktop/src/renderer/src/components/PlatformIcon.tsx) GitHub `available:true`；
      [ConnectionForm.tsx](../../apps/desktop/src/renderer/src/components/ConnectionForm.tsx) 按 kind 调整字段提示
      （GHE 的 base_url 提示、PAT scope 说明）；onboarding `PlatformStep` / `SettingsModal` 放开 GitHub 选项。
- [ ] `config:testConnection` 走 kind-aware `buildDraftAdapter`（带 base_url + token）。

### Phase 2 · GitHub adapter 读路径

- [ ] `client.ts`：GitHub REST 客户端 —— 可注入 fetch（挂代理，沿用 §08）、`Authorization: Bearer`、
      `Accept: application/vnd.github+json` + `X-GitHub-Api-Version`、`Link` 头分页迭代器、限流处理
      （403 + `X-RateLimit-Remaining=0` / `Retry-After`，search 二级限流退避）。
- [ ] `ping()`：`GET /user`（GHE 版本可读响应头 `X-GitHub-Enterprise-Version`）；缓存 currentUser 供 `getCurrentUser()`。
- [ ] `listPendingPullRequests()`：`GET /search/issues?q=is:open is:pr review-requested:@me archived:false`
      → 映射为 `PullRequest`（按需补 `GET /repos/{o}/{r}/pulls/{n}`）。**单独抬高该平台轮询间隔**（discoveryRateLimited）。
- [ ] `listPullRequestComments()`：合并 `GET /issues/{n}/comments`（summary）+ `GET /pulls/{n}/comments`
      （inline，按 `in_reply_to_id` 还原线程）→ 归一成现有 `PrComment` 树（`kind/threadId`）。
- [ ] `listPullRequestCommits()`：`GET /pulls/{n}/commits` 反转为 newest-first。
- [ ] `getUserAvatar()` / `getAttachment()`：头像直取 `avatar_url`；私有 `user-attachments` 经 PAT 代理。

### Phase 3 · GitHub adapter 写路径

- [ ] `publishInlineComment()`：`POST /pulls/{n}/comments` { body, `commit_id`=head sha, path, line, side(LEFT/RIGHT),
      start_line?/start_side? }（refs 内部拉 PR 取 head sha）。
- [ ] `replyToComment()`：inline → `POST /pulls/{n}/comments/{id}/replies`；summary → `POST /issues/{n}/comments`。
- [ ] `editComment()` / `deleteComment()`：`PATCH/DELETE /pulls/comments/{id}` 或 `/issues/comments/{id}`（无 version）。
- [ ] `setPullRequestReviewStatus()`：`POST /pulls/{n}/reviews` { event: APPROVE | REQUEST_CHANGES }；
      撤销 → `PUT /pulls/{n}/reviews/{id}/dismissals`。注意**不能审批自己的 PR**（422，UI 需对自己作者的 PR 灰显）。
- [ ] `mergePullRequest()`：`PUT /pulls/{n}/merge` { merge_method }。
- [ ] `mergeStatus`（拼装，fidelity=partial）：PR 的 `mergeable`/`mergeable_state`（容忍异步 `null`：轮询/兜底）
      + check-runs/status + 必评（分支保护）→ 已知否决项 + 「可能还有其它检查」泛化提示。
- [ ] `getCloneUrl()`：`pat` → `https://<user>:<PAT>@host/owner/repo.git`；`ssh` → `git@host:owner/repo.git`。

### Phase 4 · UI 能力位接线 + 降级（按 §8/§9）

- [ ] App 把 active 连接的 `capabilities` 传到 [MainPane](../../apps/desktop/src/renderer/src/components/MainPane.tsx)
      （审批/合并按钮）、评论组件、[ChatPane](../../apps/desktop/src/renderer/src/components/ChatPane.tsx)。
- [ ] 审批：GitHub 三态可用；**自己作者的 PR** 审批位灰显 + 原因（不能审批自己）。
- [ ] 评论：`resolvableThreads`（GitHub conversation 解决/折叠）、`suggestions`（应用入口）按能力位 显/隐。
- [ ] 严守划线：UI 只读 `capabilities` + PR 状态分支，**不出现 `if (platform==='github')`**。

### Phase 5 · 测试 + 联调 + 收尾

- [ ] `@meebox/platform-github` 过 Phase 0 的 contract 套件。
- [ ] 真实 GHE/github.com 联调：发现 → 评论往返 → inline 发布 → 审批 → 合并 全链路。
- [ ] `typecheck` / `lint` / `test` 全绿；CHANGELOG 记一条；按需 cut 版本。

## 端点映射速查（GitHub REST）

| adapter 方法 | GitHub 端点 |
| --- | --- |
| ping / getCurrentUser | `GET /user`（GHE 版本读响应头） |
| listPendingPullRequests | `GET /search/issues?q=is:open is:pr review-requested:@me` |
| listPullRequestComments | `GET /issues/{n}/comments` + `GET /pulls/{n}/comments`（线程 `in_reply_to_id`） |
| listPullRequestCommits | `GET /pulls/{n}/commits`（反转 newest-first） |
| publishInlineComment | `POST /pulls/{n}/comments`（commit_id+path+line+side+start_line?） |
| replyToComment | `POST /pulls/{n}/comments/{id}/replies` / `POST /issues/{n}/comments` |
| editComment / deleteComment | `PATCH`/`DELETE /pulls/comments/{id}` 或 `/issues/comments/{id}` |
| setPullRequestReviewStatus | `POST /pulls/{n}/reviews` {event} / `PUT /pulls/{n}/reviews/{id}/dismissals` |
| mergePullRequest | `PUT /pulls/{n}/merge` {merge_method} |
| mergeStatus | PR `mergeable_state` + `GET /commits/{sha}/check-runs`、`/status` + 分支保护 |

> 身份映射：group=owner、repo=repo、remoteId=PR number。Diff 仍走本地镜像（[模块 02](../modules/02-repo-mirror.md)），不取平台 diff 端点。

## 风险与注意

- **search 限流（30/分）+ 最终一致**：发现轮询节流；刚被请求评审可能延迟出现 → 文档/状态栏给预期。
- **mergeable 异步 null**：首开不能当不可合并；轮询/兜底，UI 中性 loading 而非永久置灰。
- **不能审批自己的 PR**：对自己作者 PR 审批位灰显 + 原因（避免 422 静默失败）。
- **本地 diff 与平台锚点对不齐**：inline 行角色严格取自本地 diff；发布失败逐条回退（现已有 toast）。
- **GHE 版本碎片**：`ping()` 探测版本，端点/字段差异按能力降级。
- **私有 user-attachments 鉴权**：经 main 端 PAT 代理（`getAttachment`），渲染层不直连。

## 验收（Done-when）

- 配 GitHub 连接（github.com 与 GHE 各一）→ 待我评审 PR 自动出现在列表。
- 选中 PR：diff/评论正常；`/review` 生成 findings；草稿确认后 inline 评论成功发布并回刷。
- 审批「通过 / 需修改」写到远端并回读；可合并时一键合并；不可用动作按 §9 灰显/隐藏 + 原因。
- Bitbucket 路径回归无变化；`@meebox/platform-github` 过 contract 套件。
