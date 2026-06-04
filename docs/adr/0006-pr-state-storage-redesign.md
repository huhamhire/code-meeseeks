# ADR-0006: PR 状态存储重新设计（per-PR 目录 + hash localId）

- **状态**：Accepted
- **日期**：2026-06-02
- **决策者**：项目主导
- **取代**：ADR-0003 关于 `state/pull-requests.json` 单文件聚合 + `state/runs/<sanitized-localId>/<runId>.json` 的部分

## 背景

M3 之前的 PR 状态布局：

- `state/pull-requests.json` 单文件聚合所有 PR 索引 + 元数据
- `state/runs/<sanitized-localId>/<runId>.json` per-PR 子目录存 review run，但 localId 用 `<conn>:<remote>` 拼接 + 文件名做 `:` → `--` 转义
- 评论每次进 PR 都从远端现拉，无缓存

暴露的问题：

1. **localId 唯一性不足**：Bitbucket Server PR id 是 per-repo 递增的，同一连接下不同 repo 完全可能撞 id（`proj-A/repo-x#42` 与 `proj-A/repo-y#42`）
2. **每次切 PR 重拉评论**：用户切走再回来等远端往返
3. **PR 描述 / 元数据没有"上下文切换不丢"的能力**：上下文切换过程，每次都要重新走 Bitbucket Server API
4. **退场即彻底丢**：merged / declined PR 进入"消失"分支后状态被剪，agent runs 历史也跟着丢，用户回头查不到
5. **路径越界缺保护**：StateStore 的 key 直接 join 到磁盘路径，理论上不安全输入可越界

## 决策

### 1. PR localId = hash

```
localId = sha1("<platform>|<connectionId>|<group>|<repo>|<remoteId>").slice(0, 12)
```

- **12 hex chars (≈ 48 bit)**：单用户使用规模碰撞概率可忽略
- **路径友好**：无 `:` / `/`，跨平台无需 sanitize
- **多平台中性 identity**：Bitbucket Server / GitHub / GitLab / Gitea 用同一份 schema (`platform / group / repo`)，参见 `PrIdentity` doc
- 实现在 `@meebox/poller` 的 `pr-hash-id.ts`，纯函数

### 1.1 PrIdentity 多平台抽象

| 抽象字段 | Bitbucket Server | GitHub | GitLab | Gitea |
|---|---|---|---|---|
| `platform` | bitbucket-server | github | gitlab | gitea |
| `group` | projectKey | owner (org/user) | namespace | owner |
| `repo` | repoSlug | name | name | name |
| `remoteId` | PR id (数字字符串) | PR number | MR iid | PR id |
| `connectionId` | 本地连接 id（用户在 config.yaml 给某个账号起的名字；同一 host 多账号靠它区分）|
| `url` | 远端 PR URL 快照 (可选)，不进 hash |

M3 仅 Bitbucket Server；M5 接入其他平台时 adapter.kind 直接落 platform 字段，无需 schema 变更。

### 2. Per-PR 目录布局

```
state/
├── prs/
│   ├── index.json                 # hash → PrIndexEntry，单一来源
│   ├── <hash>/
│   │   ├── meta.json              # 完整 PR 元数据 (StoredPullRequest)
│   │   ├── comments.json          # 评论快照 + cache key
│   │   └── runs/
│   │       └── <runId>.json       # agent 会话 (跟 PR 同寿命，PR 退场一并清)
│   └── ...
├── connections.json
├── watched-repos.json
└── posted-comments.json           # 不动；横向幂等记录，跟 PR 目录解耦
```

**`prs/index.json` 形态**：

```ts
interface PrIndexFile {
  schema_version: 1;
  prs: Record<string, PrIndexEntry>; // key = hash localId
}
interface PrIndexEntry {
  identity: PrIdentity;   // 见 §1.1
  updatedAt: string;     // 远端 pr.updatedAt 镜像，用于缓存失效判定
  discoveredAt: string;
  lastSeenAt: string;
  archivedAt: string | null;  // 软删时间戳，软删窗口内 listStoredPullRequests 过滤
}
```

索引承担 lookup + 退场判定；完整 PR 元数据 (title / refs / reviewers...) 落在 `meta.json` 里。

**自描述字段（避免单文件强依赖 index）**：

- `meta.json` 的 `StoredPullRequest` 顶层新增 `platform: PlatformKind` —— 跨存储迁移 / 备份 / 离线分析时 meta 自带平台标识
- `runs/<runId>.json` 的 `ReviewRun` 可选字段 `prIdentitySnapshot?: PrIdentity` —— M5 归档单 run 时反查远端 PR；M3 默认不填

`comments.json` 的 `PrComment` 本身已是平台中性 (id / author / body / lineRef 等)，不再额外加 identity 字段。

### 3. 软删 + 1 周 grace 期

PR 在远端 reviewer 列表消失（merged / declined / 我不再是 reviewer）→ **软删**（`archivedAt = now`），不立即清理磁盘。

- **窗口期内**（≤ 1 周）：`listStoredPullRequests` 过滤掉，UI 看不见；但 `meta.json` / `comments.json` / `runs/*.json` 都保留
- **远端重新出现**：自动复活（archivedAt 清零）
- **grace 期满**（>1 周）：下一轮 poll 时 `deleteDir(prs/<hash>)` 整棵清掉

为什么留 1 周：用户可能事后回顾自己评审过哪个 PR，1 周覆盖大多数"上周二我跟那个 PR 聊了什么"场景。

`PURGE_GRACE_MS` 在 `pr-state.ts` 中定义，将来需要可在配置里挪。

### 3.1 Finding schema 范式

`Finding` 在 M3 解析层只填到 `body / anchor / sectionKey`；M4 评审 → 发布闭环
需要的扩展字段已经预留在 schema 里（M3 不填，M4 启动时直接补逻辑）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `severity` | `'info' \| 'warning' \| 'error'` | UI 着色 / 排序 |
| `status` | `'pending' \| 'accepted' \| 'edited' \| 'rejected' \| 'posted'` | 评审决断状态机 |
| `draft_body` | `string` | 用户改写后的评论正文，仅 `status='edited'` 时填 |
| `posted_remote_id` | `string` | 发布成功后远端评论 id，幂等 key |

### 4. 评论缓存（per-PR）

`prs/<hash>/comments.json`：

```ts
interface CommentsCacheFile {
  schema_version: 1;
  pr_updated_at: string;  // 写入快照时 PR meta 的 updatedAt 值
  fetched_at: string;
  comments: PrComment[];
}
```

**失效判定**：缓存里的 `pr_updated_at` ≠ 当前 PR meta 的 `updatedAt` 即视为 stale，需要重拉。

**why `pr.updatedAt`**：Bitbucket Server 的任何 PR 变更（新评论 / 状态切换 / 描述编辑）都会跳 `updatedAt`，是足够保险的 cache key。

进 PR 触发 `diff:listComments` 时：

1. 读 `comments.json`，cache key 一致 → 直接返回缓存
2. 不一致 / 文件不存在 → 从远端拉 → 落新缓存 → 返回

### 5. 安全 invariants（用户硬要求）

#### 5.1 拉取失败不动本地

**单连接 listPendingPullRequests 抛错**：

- 不写其名下任何 PR 的 meta
- 不软删名下既有 PR
- 不从索引剔除任何条目
- 实现靠 `seenByConnection` 只装成功连接的 hash 集合；soft archive 循环只迭代 `seenByConnection` 里的连接

**所有连接全失败**：

- 索引文件 0 写入（`dirty` flag 控制）
- 磁盘 mtime 不变，避免误触发上层 watcher / 备份工具

**硬清独立**：archived PR 过 grace 期的清理跟当轮 poll 成败无关——archivedAt 是过去某次成功 poll 决定的事实。

#### 5.2 路径越界保护

`JsonFileStateStore` 所有 fs 操作 (`read` / `write` / `delete` / `deleteDir` / `list`) 都过一道 `subpathInside(rel)` 屏障：

- `..` 跳出 stateDir 抛 `path traversal`
- 绝对路径 key 抛 `path traversal`
- `deleteDir('')` / `deleteDir('.')` 拒绝清空 stateDir 根

为什么必须：StateStore key 由调用方拼接（含 PR localId / runId / 评论缓存等），key 一旦混入未净化的用户输入（远端 PR slug 含 `../` / connection id 派生方式漏过校验），没有这层屏障就能在用户工作目录之外读写文件。

### 6. 容错与最终一致

state 目录可能被外部清理 / 同步工具操作；设计保证：

| 外部操作 | 当前行为 | 恢复机制 |
|---|---|---|
| `prs/index.json` 被删 | `read` 返回 null，list 为空 | 下一轮 poll 重建 |
| `prs/<hash>/meta.json` 被删 | listStoredPullRequests 跳过该条目 | 下一轮 poll 若 PR 仍在远端 → 重写；否则软删进 grace |
| `prs/<hash>/comments.json` 被删 | `readCommentsCache` 返回 null | 下一次 `diff:listComments` → 远端拉 + 重写 |
| `prs/<hash>/runs/<runId>.json` 被删 | listReviewRunsForPr 跳过 | 不可恢复但不崩 |
| 整 `prs/<hash>/` 目录被删 | 索引 entry 暂时孤立 | poll 重建 meta；comments 按需重拉；runs 永久丢 |
| `prs/index.json` 损坏 JSON | `read` 抛错，poll 当轮 fail | 用户介入后下一轮自动重建 |

原则：**读宽容 (null/skip)，写幂等 (overwrite)，poll 是唯一权威，远端是最终 truth**。

不主动做的事：

- 启动时 `reconcile` 扫孤儿目录（暂时让它们占磁盘；M5 加 housekeeping job）
- 自动 backup / restore from corruption
- 文件锁 / 多进程协调（ADR-0003 已确认单写者假设）

## 不在本次范围

- **旧数据迁移**：用户确认本地开发阶段直接清空 `state/` 重新拉，不写迁移脚本
- **/improve 工具的 finding 落到 meta**：M4 的事
- **comments 强制刷新按钮**：当前 cache 失效判定已经够灵敏，按需再加

## 影响

### 跨包修改

- `@meebox/state-store`：`StateStore.deleteDir(prefix)` 接口 + `JsonFileStateStore` 路径屏障实现
- `@meebox/poller`：
  - 新增 `pr-hash-id.ts` (`prHashId(identity)`) / `pr-state.ts` (PR index + meta + 软删 + 硬清) / `comments-cache.ts`
  - 重构 `poller.ts`：用 hash localId / 写 per-PR meta / 软删 + 硬清
  - 重构 `runs.ts`：`prs/<hash>/runs/<runId>` 路径，去掉 `sanitizePrLocalIdForPath`
- `@meebox/shared`：`StoredPullRequest.localId` / `ReviewRun.prLocalId` 注释更新（hash 形态）
- `apps/desktop` (`main/ipc.ts`)：`diff:listComments` 接 comments cache（cache key 命中走缓存，miss 拉远端 + 写缓存）

### 测试

- 新增 state-store 路径越界 + deleteDir 测试（5 个）
- 新增 poller 测试：hash 多 repo 不撞 / 软删 / 复活 / 1 周 grace 硬清 / 全 fail 零写入 (5 个)
- 调整既有 poller / runs 测试用 hash localId

## 选择空间（未来想改）

- **localId 形态**：若发现 12 chars 太短或太长，prHashId 可直接调 slice 长度（已落盘的数据需要清掉重拉）
- **grace 期**：1 周是直觉，没有数据支撑。可调成 config 项
- **comments cache key**：当前只看 PR `updatedAt`。若有发现 Bitbucket Server 评论变更不跳 PR updatedAt 的边缘情况，再加 ETag / 二级 key

## 参考

- 实现：[packages/poller/src/pr-hash-id.ts](../../packages/poller/src/pr-hash-id.ts)、[packages/poller/src/pr-state.ts](../../packages/poller/src/pr-state.ts)、[packages/poller/src/comments-cache.ts](../../packages/poller/src/comments-cache.ts)
- 状态存储抽象层：[ADR-0003](./0003-state-storage-and-workspace-layout.md)（未变，本 ADR 只调整其内部 key/路径布局）
