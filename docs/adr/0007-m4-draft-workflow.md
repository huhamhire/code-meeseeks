# ADR-0007: M4 评审 → 发布闭环的草稿工作流

- **状态**：Accepted
- **日期**：2026-06-02
- **决策者**：项目主导
- **相关**：[ROADMAP §5 M4](../ROADMAP.md)、[ADR-0006](./0006-pr-state-storage-redesign.md)（per-PR 状态目录），M3 已落地的 `/review` code-feedback finding 是数据源

## 背景

M3 收官时已确认 `/improve` 工具在 pr-agent 社区版 + LocalGitProvider 路径下不可用（pr-agent 的 `publish_code_suggestions` 仅在线平台 GitHub / GitLab / Bitbucket Cloud 工作）。M4 评审 → 发布闭环改走方案 **D**：复用 `/review` 输出的 code-feedback finding（已带 `anchor.path` + `startLine` + `endLine`）作为 inline 评论候选源。

工作流总览：

```
/review 跑一次 (M3 已有)
   ↓
code-feedback findings 自动入草稿池 (M4 本 ADR)
   ↓
Diff 视图内联展示候选草稿 + 用户编辑 / 拒绝 / 手动追加
   ↓
批量发布到 Bitbucket Server 作 inline comment
```

不直接发布。所有候选 / 编辑 / 拒绝都先沉淀在本地草稿池，**用户显式确认后才批量 POST 远端**。

## 决策

### 1. 草稿数据模型

```ts
interface ReviewDraft {
  /** 唯一稳定 id (uuid 或 runId+findingId 派生)，UI list-key + 持久化引用 */
  id: string;
  anchor: {
    path: string;
    startLine: number;
    endLine: number;
    side: 'old' | 'new';
  };
  /** 当前评论正文。pending 时 = AI 建议原文；edited 时 = 用户编辑后 */
  body: string;
  /** 来源：AI 建议 vs 用户手动添加 */
  origin: 'finding' | 'manual';
  /**
   * origin='finding' 时填，指回源 finding (跨 ChatPane / DiffView 互联用)。
   * origin='manual' 不填。
   */
  source?: { runId: string; findingId: string };
  status: 'pending' | 'edited' | 'posted' | 'rejected';
  /** 发布成功后远端 comment id，幂等 key + 跳转链接 */
  posted_remote_id?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

落盘到 `state/prs/<localId>/drafts.json`（per-PR 目录，跟 ADR-0006 布局一致；PR 退场时 deleteDir 整树清掉）。

### 2. 草稿懒创建 + /review 再摄入规则

**草稿懒创建（不在 /review 完成时全量预建）**：

```
/review 完成 → ChatPane 渲染 N 条 code-feedback finding (这是 finding 列表，AI 的不可变快照)
                  ↓ (用户从 ChatPane 点 "→ 跳到代码")
                lookup drafts.json：
                  - 已有匹配 finding 的 draft (source.runId+findingId) → 打开它
                  - 无 → 当场创建 pending 草稿 (body=finding.body)
                  ↓
                DiffView 滚到 anchor + 打开内联编辑 zone
```

理由：

- 用户预期一次 /review 全候选就位，但不是所有候选都会被采纳。**全部预建会污染"待发送计数"** —— 用户看到 finding 列表里 20 条，可能只想发 3 条，剩下 17 条变 pending 草稿没意义
- ChatPane 的 finding 卡片是 AI 候选的天然展示位（M3 已有），不需要把 finding 提前 copy 一份到 drafts 池
- 用户点了才创建，意味着 drafts.json 只装"用户实际关心过的"草稿；"提交评审 (N)" 按钮的 N 是真实意图，不是 AI 噪音

**Re-run /review 时的清理规则**（边界情况）：

```
新 /review 完成时，扫 drafts.json：

  1. 丢弃 (drop)：
       status === 'pending' AND origin === 'finding'
     → 上轮 AI 候选被用户"点开过但没动"的草稿。本轮 AI 重新给意见就清掉，
        避免新老候选混跑

  2. 保留 (keep)：
       status ∈ {edited, posted, rejected}     ← 用户已投入决断
       OR origin === 'manual'                   ← 用户手动加的，AI 管不着
```

**Edited / posted / rejected / manual 永不被覆盖**，是设计核心保障 —— 用户投入的决断不会因为再跑一次 /review 而丢失。

**反馈展示**：每次 /review 完成在 RunResultView meta 行加统计 chip：

```
/review SUCCEEDED Docker 9.8k tokens 90s   → 生成 5 条候选 · 清理 1 条旧待处理 · 保留 2 条已编辑/已发
```

`生成 N 条候选` 指 ChatPane 的 finding 数，**不是**新建草稿数（懒创建逻辑下不需要建）。

### 3. 状态机

```
                         (origin='finding')
                         /
   /review run ─► pending ─────► edited (用户改写)
                  │  ▲           │
   (用户 +)       │  │           │
   ─────────────► pending ───────┤
   (origin='manual')              │
                  │                ▼
                  └─────────────► posted  (批量发布成功后)
                  │
                  └─────────────► rejected (用户拒绝；UI 默认隐藏)
```

转换规则：
- `pending → edited`：用户改了 body
- `pending / edited → posted`：批量发布成功，写入 `posted_remote_id`
- `pending / edited → rejected`：用户主动 reject
- `rejected → pending`：用户后悔了，从隐藏列表恢复（可选 P2）
- `posted → *`：不允许逆变 (远端已存，本地不该撤回；改远端要走 BBS API)

### 4. IPC 契约

```ts
'drafts:list':   { request: { localId }; response: ReviewDraft[] };
'drafts:add':    { request: { localId; draft: Omit<ReviewDraft, 'id'|'createdAt'|'updatedAt'> }; response: ReviewDraft };
'drafts:update': { request: { localId; draftId; patch: Partial<ReviewDraft> }; response: ReviewDraft };
'drafts:delete': { request: { localId; draftId }; response: void };
'drafts:publishBatch': { request: { localId; draftIds: string[] }; response: Array<{ draftId; ok; remoteId?; error? }> };

// 事件
'drafts:changed': { localId: string }   ← main 写盘后广播；renderer 重拉
```

### 5. 自动入草稿池的触发点

`pragent:run` IPC handler 在 `/review` 成功 + parse 出 code-feedback findings 后，**同一笔事务里**应用第 2 节算法写回 drafts.json，再广播 `drafts:changed`。失败的 /review run 不触发草稿入池（没建设性数据）。

### 6. 发布到远端 (Phase 2)

```ts
adapter.publishInlineComment(
  repo,
  prId,
  {
    text: draft.body,
    anchor: {
      path: draft.anchor.path,
      line: draft.anchor.endLine,  // BBS 锚最后一行
      lineType: 'CONTEXT',         // 保守值，BBS 7+ 接受
      fileType: draft.anchor.side === 'old' ? 'FROM' : 'TO',
    },
  },
)
```

返回新 comment 的 `remoteId` → 写回 draft.posted_remote_id + status='posted'。

批量发布串行执行（一个失败不阻断后续），全部完成后给统计 toast：`已发布 N / 失败 M`。

### 7. 展示形态架构

不引入新的"草稿"tab，而是**复用现有的 ChatPane finding 列表**做候选展示，DiffView 做编辑动作发生地：

```
┌──────────────────────────────┐  ┌──────────────────────────┐
│  ChatPane (右栏)             │  │  DiffView (主栏)         │
│  ─────────────               │  │  ────────                │
│  /review run 卡片            │  │   代码 + 远端评论 zone   │
│   ↓                          │  │   ↑                      │
│  Finding card 列表           │  │   ↑ (滚动 + 打开 zone)   │
│   ├ [代码反馈] foo.ts:42      │  │                          │
│   │  [✎ 跳到代码编辑]   ←──┼──┘                          │
│   │  [✗ 拒绝]               │                                │
│   │  待处理 / 已编辑 / ...  │                                │
│   └ ...                     │                                │
└──────────────────────────────┘
                ↑
                │ 点 "→ 跳到代码" 触发
                │   1. 切到 Diff tab (如不在)
                │   2. 滚到 anchor 行 (短暂 highlight)
                │   3. 懒创建 / 打开草稿 inline 编辑 zone
```

**职责划分**：

| 表面 | 角色 | 数据 |
| --- | --- | --- |
| **ChatPane finding 卡片** | AI 候选列表，跳转入口 | Finding (不可变) + 关联 Draft 的 status chip |
| **DiffView 内联 zone** | 编辑 / 拒绝 / 创建动作的发生地 | Draft (可变) |
| **PR header 「提交评审 (N)」按钮** | 批量发布入口 | drafts.json (pending + edited 计数 + modal 概览) |

**ChatPane finding card 行为**：

- 每条 code-feedback finding (带 anchor) 加：
  - **状态 chip**：`待处理 / 已编辑 / 已发布 / 已拒绝`，反映关联 Draft 状态
  - **「→ 跳到代码编辑」按钮**：触发跳转 + 懒创建草稿
  - **「✗ 拒绝」按钮**：直接置 Draft status='rejected'，无需先跳到 diff
- Card body **始终显示 Finding 原文** (AI 当时说的话)；要看 / 改用户编辑后版本 → 跳 diff
- 已拒绝 finding 默认折叠成一行：`已拒绝 N 条建议 [展开]`

**DiffView 内联草稿**：

- 复用现有 view zone 机制 (跟远端评论同基础设施)
- 视觉区分：远端评论黄底，草稿**蓝底 + DRAFT chip**
- 状态可视化：
  - `pending` / `edited` 蓝色 + 编辑/删除按钮
  - `rejected` 默认不渲染
  - `posted` 切回黄底 (跟远端评论形态一致) + 远端 id 链接
- 行 hover 出 `+` 按钮 → 创建 `origin='manual'` 草稿 + 当场打开编辑

**「提交评审 (N)」按钮 (替代 panel tab)**：

- 位置：PR header 操作区，跟「浏览器打开」「通过 / 需修改」并列
- N = pending + edited 草稿计数 (manual + finding 都计)
- 点击 → modal 列出全部待发草稿，每条带 `path:line + body 预览 + origin chip` → 「确认发布」/「取消」
- 这就是 panel 的"按需出现"形态，不占常驻 tab

**手动草稿 (`origin='manual'`)** 不回显到 ChatPane (chat 永远是 AI 的叙事)；只在 Diff inline + 提交 modal 看得到。

### 8. 不在本 ADR 范围

- **快捷键 / 拖拽 / 合并多条草稿**：M4 稳定后再补
- **/improve 接入**：等 pr-agent 上游支持 local provider 或我们自己实现 monkey-patch 路径再说
- **rejected 草稿恢复操作**（从隐藏列表拉回 pending）：P2 视使用频率再加
- **草稿内 markdown 预览**：M4 内不做，纯 textarea 软换行即可

## 影响

### 跨包修改

- `@pr-pilot/shared`：新增 `ReviewDraft` / `DraftsFile` / IPC 契约（drafts:* + drafts:changed 事件）
- `@pr-pilot/poller`：新增 `drafts.ts` 模块（list / add / update / delete / publish）+ `/review` 完成时的"再摄入"钩子
- `@pr-pilot/platform-bitbucket-server`：实现 `publishInlineComment`（适配器接口扩展）
- `apps/desktop/src/main`：IPC handler + 自动入池触发
- `apps/desktop/src/renderer`：DiffView 内联草稿渲染 + 草稿编辑 UX + 批量发布按钮

### 跟既有架构的关系

- ADR-0006 per-PR 目录天然容纳 `drafts.json`，无需路径调整
- M3 落地的 `Finding.status / draft_body / posted_remote_id` 字段当时是预留，本 ADR 把它们用起来；但状态权威源**从 Finding 迁到 ReviewDraft** —— Finding 是 /review 输出的不可变快照，Draft 是用户工作中的可变态
- ChatPane 的 finding 列表跟 DiffView 的草稿池 / DraftPanel 是**两个独立的可视化**指向**同一数据**（finding 不可变，draft 可变；draft 的 source 字段把它跟 finding 关联）

## 后续 / 阶段

- **Phase 1（核心，~1-1.5 天）**：草稿 schema + storage + IPC
  - ChatPane finding card 加 status chip + 「→ 跳到代码编辑」/「✗ 拒绝」按钮
  - DiffView 内联草稿 view zone (蓝底 DRAFT) + 编辑 / 删除
  - 行 hover `+` 创建 manual 草稿
  - 跳转交互 (切 tab + 滚动 + highlight + 懒创建)
  - 还**不能发布**，所有草稿停在本地
- **Phase 2（~半天）**：批量发布
  - BBS adapter `publishInlineComment`
  - PR header 「提交评审 (N)」按钮 + 确认 modal
  - 串行 POST + status='posted' + posted_remote_id
- **Phase 3（~半天）**：稳健化
  - `posted-comments.json` 幂等防重复
  - 失败重试 + 单条标错不阻断后续
  - rejected 草稿折叠 / 展开 UI

## 参考

- M3 落地的 [Finding 字段预留](../../packages/shared/src/poller-contract.ts)（severity / status / draft_body / posted_remote_id）
- [ADR-0006](./0006-pr-state-storage-redesign.md) per-PR 目录布局
- [ROADMAP §5 M4](../ROADMAP.md#m4--确认--评论发布闭环)
