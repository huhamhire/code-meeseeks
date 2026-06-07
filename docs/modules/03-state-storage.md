# 03 · 状态存储与数据模型

## 职责与边界

持久化 PR 元数据、评论缓存、评审 run、连接/已观察仓库等。一期用 **JSON 文件**（非 SQLite），
封装在 `StateStore` 接口后，将来可平滑换实现。

负责：状态读写、PR 目录布局、软删与清理、路径安全。不负责：配置/凭据（见 [07](07-config-and-secrets.md)）、
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
- **per-PR 目录布局**：
  ```
  state/prs/
  ├── index.json              # hash → PrIndexEntry（lookup + 退场判定的单一来源）
  └── <hash>/
      ├── meta.json           # 完整 PR 元数据 StoredPullRequest（自带 platform 字段）
      ├── comments.json       # 评论快照 + cache key
      └── runs/<runId>.json   # 评审会话（跟 PR 同寿命）
  ```
  另有 `connections.json` / `watched-repos.json` / `posted-comments.json`（横向幂等记录，与 PR 目录解耦）。
- **评论缓存按 PR `updatedAt` 失效**：`comments.json` 存写入时的 `pr_updated_at`；与当前 PR meta 的 `updatedAt`
  不一致即 stale → 重拉。Bitbucket 任何 PR 变更都跳 `updatedAt`，是足够保险的 cache key。
- **软删 + 1 周 grace**：PR 从远端 reviewer 列表消失（merged/declined/不再是 reviewer）→ 标 `archivedAt`，
  不立即删盘；窗口内 UI 隐藏但数据保留、远端复现自动复活；过期下轮 poll 整目录清掉。便于事后回看。
- **安全 invariant**：
  - **拉取失败不动本地**：某连接 `listPendingPullRequests` 抛错 → 不写其名下 PR、不软删、不剔索引；
    全失败则索引零写入、mtime 不变（避免误触 watcher/备份）。poll 是唯一权威，远端是最终 truth。
  - **路径越界屏障**：所有 fs 操作过 `subpathInside` 检查（拒 `..` / 绝对路径 / 清空根），因为 key 由调用方
    拼接（含 PR localId / runId），必须防未净化输入越界读写。
- **读宽容、写幂等**：状态文件被外部删/坏时，读返回 null/skip、下一轮 poll 重建；不做启动 reconcile / 自动备份。

## 数据 / 接口契约

- `StateStore`：`read<T>(key)` / `write<T>(key,data)` / `delete(key)` / `deleteDir(prefix)` / `list(prefix)`。
- `PrIndexEntry`：`identity`(PrIdentity) / `updatedAt` / `discoveredAt` / `lastSeenAt` / `archivedAt|null`。
- `StoredPullRequest`：完整 PR 元数据 + `platform`（自描述）。
- `ReviewRun`：见 [05](05-review-workflow.md)（含 `findings` / `tokenUsage` / `model` / 状态机字段）。
- 所有文件含 `schema_version`。

## 扩展与注意事项

- **升级 SQLite**：只换 `StateStore` 实现 + 数据迁移，接口与业务不动。
- **grace 期 / hash 长度 / cache key** 都是直觉取值，留了可调空间（改动需清空 `state/` 重拉）。
- **本地开发**：schema 变更阶段直接清空 `state/` 重拉，不写迁移脚本。
- 孤儿目录（索引无条目）暂不主动清理，占盘但不影响功能，后续加 housekeeping。
