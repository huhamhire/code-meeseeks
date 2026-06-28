# 03 · 状态存储与数据模型

## 职责与边界

持久化 PR 元数据、评论缓存、评审 run、连接/已观察仓库等。一期用 **JSON 文件**（非 SQLite），
封装在 `StateStore` 接口后，将来可平滑换实现。

负责：状态读写、PR 目录布局、软删与清理、路径安全。不负责：配置/凭据（见 [08](08-config-and-secrets.md)）、
仓库镜像（见 [02](02-repo-mirror.md)）。

## 核心设计

- **JSON 文件 + `StateStore` 抽象**：`read/write/delete/deleteDir/list`。一期实现 `JsonFileStateStore`，
  每个 key 一个文件（相对 `state/` 根）。**原子写**：tmp → fsync → rename，避免崩溃留半截文件。
  单写者（Main 进程独占），无文件锁。所有文件带 `schema_version`。
  为什么不上 SQLite：规模小（最多数百 PR / 数千 finding）；native 模块要按 Electron 版本逐平台重编译，
  CI 矩阵麻烦。触发阈值（单文件 >10MB 频繁读写 / 跨实体复杂查询 / 实测瓶颈）到了再换实现，业务层不变。
- **PR localId = hash**：`sha1("<platform>|<connectionId>|<group>|<repo>|<remoteId>").slice(0,12)`。
  理由：Bitbucket PR id 是 per-repo 递增的，同连接不同 repo 会撞号；hash 唯一且路径友好（无 `:`/`/`，跨平台免 sanitize）；
  多平台共用同一 identity。
- **per-PR 目录布局**（活跃 PR 落 `state/prs/`，退场 PR 整树搬到平级的 `archived/prs/` 冷存储）：
  ```
  ~/.code-meeseeks/
  ├── state/prs/
  │   ├── index.json          # hash → PrIndexEntry（lookup + 退场判定的单一来源；含活跃 + 归档全部条目）
  │   └── <hash>/             # 仅活跃（在场）PR
  │       ├── meta.json       # 完整 PR 元数据 StoredPullRequest（自带 platform 字段）
  │       ├── comments.json   # 评论快照 + cache key
  │       ├── read-state.json # 用户已读水位（未读标记派生用，仅 markRead 写）
  │       └── runs/<runId>.json # 评审会话（跟 PR 同寿命）
  └── archived/prs/<hash>/    # 退场（软删）PR 的同形冷存储；grace 期满整树清掉
  ```
  - **活跃 / 归档物理分离**：`state/` 与 `archived/` 是两个平级的 `StateStore` 根。活跃存储只装在场 PR；
    PR 退场时其 `prs/<hash>/` 整树经 `relocateTree(state → archived)` 搬入冷存储，复活时反向搬回。
    交互 / IPC 层只读活跃存储（`listStoredPullRequests` 天然不含归档），归档仅供生命周期清理。
  - **索引仍单点**：`index.json` 只在活跃存储维护，是「哪些 hash 存在 + archivedAt」的唯一真相，覆盖活跃 + 归档全部条目；
    数据所在根由 `archivedAt` 是否为空隐含决定（空=活跃存储 / 非空=归档存储）。
  - 另有 `connections.json` / `watched-repos.json` / `posted-comments.json`（横向幂等记录，与 PR 目录解耦）。
- **评论缓存按 PR `updatedAt` 失效**：`comments.json` 存写入时的 `pr_updated_at`；与当前 PR meta 的 `updatedAt`
  不一致即 stale → 重拉。Bitbucket 任何 PR 变更都跳 `updatedAt`，是足够保险的 cache key。
- **软删 + 1 周 grace + 冷存储搬迁**：PR 从远端 reviewer 列表消失（merged/declined/不再是 reviewer）→ 把整树搬入
  `archived/` 冷存储、再标 `archivedAt`（搬迁先于索引落盘，崩溃可幂等重来），不立即删盘；窗口内 UI 隐藏但数据保留，
  远端复现时整树搬回活跃存储、自动复活；grace 期满下轮 poll 从**归档 + 活跃两端**整目录清掉（两端清以兜旧布局 /
  异常 split-brain 残留）。便于事后回看。
- **对账（最终一致）**：每轮 poll 遍历 archived 条目时，未到 grace 的若数据仍滞留活跃存储 → 整树搬入归档存储
  （`relocateTree(state → archived)`，已就位者源缺失即 no-op）。覆盖升级前旧布局的存量、异常 split-brain 残留、
  中断的搬迁，使「凡 archived 必在 archived/」自动收敛——无需迁移脚本。对账只搬数据、不改索引，不破「全失败 poll 零索引写」不变式。
- **未读标记**：`listStoredPullRequests` 派生 `StoredPullRequest.unread`（不持久化）。规则：**从未打开过**（无 read-state）即
  未读——覆盖新分配 / 请求评审的新到达，以及清空目录 / 全新安装后涌入的 PR；**打开过之后**则看源 head 又变（新 commit）或已读
  时间后有「@我 / 回复我」评论（`index.lastMentionAt > read-state.lastReadAt`）。两类状态**分文件、分写者**以避开竞态：**已读水位**
  `read-state.json`（`lastReadHeadSha`+`lastReadAt`）**仅** `prs:markRead`（用户打开 PR）写、poll 一概不碰；**mention 游标**
  `index.lastMentionAt` 由 poll 独占维护（poll 整体重写 index.json，不会覆盖用户水位），仅在 PR `updatedAt` 跳变时拉评论扫描、与
  历史取较大值，成本与活动量成正比。commit 检测对各平台通用、不依赖 `updatedAt`。早期开发版不做升级兼容（不抑制旧存量泛红，清库 / 重装即可）。
- **安全 invariant**：
  - **拉取失败不动本地**：某连接 `listPendingPullRequests` 抛错 → 不写其名下 PR、不软删、不剔索引；
    全失败则索引零写入、mtime 不变（避免误触 watcher/备份）。poll 是唯一权威，远端是最终 truth。
  - **路径越界屏障**：所有 fs 操作过 `subpathInside` 检查（拒 `..` / 绝对路径 / 清空根），因为 key 由调用方
    拼接（含 PR localId / runId），必须防未净化输入越界读写。
- **读宽容、写幂等**：状态文件被外部删/坏时，读返回 null/skip、下一轮 poll 重建；不做启动 reconcile / 自动备份。
- **启动清扫孤儿 tmp**：原子写「tmp → rename」中，进程在两步之间被强杀 / 退出（如关窗瞬间的 in-flight 异步写）会留下 `*.tmp`
  孤儿、跨会话累积。`sweepStaleTmpFiles` 在启动早期、任何写入之前删掉全部 `*.tmp`——单写者前提下此刻无 in-flight 写，凡 tmp 皆为
  上次会话孤儿，可放心删；**绝不在运行期清扫**，以免误删并发写 / rename 重试正在用的 tmp（冲突场景不误删多余文件）。
- **启动清扫归档孤儿**：按索引遍历的硬清够不到「索引丢失 / 重建后失去条目」的归档数据（poll 只从远端补回活跃 PR），
  会在 `archived/prs/` 永久滞留。`sweepOrphanedArchivedPrs`（启动期、写入前）以无索引方式兜底：walk `archived/prs/*`，
  对「统一索引无对应条目 **且** 目录 mtime 超 grace」的整树删掉（mtime 作 archivedAt 的代理）。双重保守避免误删暂时
  不在索引里的目录；机制为 `JsonFileStateStore.sweepOrphanDirs`。**正常清理仍走统一索引的到期硬清，此处仅补索引丢失的缺口。**

## 数据 / 接口契约

- `StateStore`：`read<T>(key)` / `write<T>(key,data)` / `delete(key)` / `deleteDir(prefix)` / `list(prefix)`。
- `relocateTree(from, to, prefix)`：跨 store 整树搬迁（list→read→write→deleteDir），用于活跃⇄归档存储间搬 PR 子树。
  目标先清空（源为权威）、源末删（幂等 / 崩溃可重来）、源缺失即 no-op；不破 `StateStore` 抽象、无需暴露文件系统根。
- `PrIndexEntry`：`identity`(PrIdentity) / `updatedAt` / `discoveredAt` / `lastSeenAt` / `archivedAt|null` /
  mention 游标 `lastMentionAt?`。
- `PrReadStateFile`（`read-state.json`）：`lastReadHeadSha` / `lastReadAt`（用户已读水位）。
- `StoredPullRequest`：完整 PR 元数据 + `platform`（自描述）。
- `ReviewRun`：见 [05](05-review-workflow.md)（含 `findings` / `tokenUsage` / `model` / 状态机字段）。
- 所有文件含 `schema_version`。

## 扩展与注意事项

- **升级 SQLite**：只换 `StateStore` 实现 + 数据迁移，接口与业务不动。
- **grace 期 / hash 长度 / cache key** 都是直觉取值，留了可调空间（改动需清空 `state/` 重拉）。
- **本地开发**：schema 变更阶段直接清空 `state/` 重拉，不写迁移脚本。
- 孤儿目录（索引无条目）暂不主动清理，占盘但不影响功能，后续加 housekeeping。
