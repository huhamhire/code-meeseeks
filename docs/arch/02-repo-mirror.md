# 02 · 仓库镜像与 Diff

## 职责与边界

把 PR 涉及的仓库镜像到本地，供 Diff 展示、blame、以及给 pr-agent 提供工作树。所有 git 操作走
`simple-git` + 系统 `git`。

负责：bare 镜像的 clone/fetch、worktree 物化、按 sha 读文件与算 diff、blame、磁盘占用统计。
不负责：从平台 REST 抓 diff（不用，平台 diff 会截断）、评论（见 [01](01-platform-adapter.md)）。

## 核心设计

- **完整 bare 镜像（`--mirror`）**：每个仓库一份 bare 镜像，含**全部 refs**。关键是 Bitbucket 把 PR 源
  sha 放在 `refs/pull-requests/<id>/from`，普通 `--bare` 拉不到会导致 `git diff base...head` 找不到 head。
  早期试过 `--filter=blob:none` partial clone 省盘，但 blame / pr-agent 需要历史 blob 时会触发按需拉取、
  远端不全时直接 fatal —— 故改回完整 clone，磁盘代价交给可配置的 `repos_dir`（见 [03](03-state-storage.md)）。
- **首次 clone，后续增量 fetch**：fetch 用显式 refspec 覆盖式拉 `refs/heads/*` + `refs/pull-requests/*/from`。
- **全局串行 sync 队列**：任意时刻只有一个仓库在 clone/fetch——多个调用方（切 PR / 定时）共用同一队列，
  不并发打远端、不抢 git 带宽，进度更稳；同一仓库的并发请求复用同一 in-flight Promise。读操作不走队列。
- **worktree 物化**：从本地 bare **`git clone --local --no-checkout`** 派生独立 repo（同盘 objects 走 hardlink，
  磁盘 ~0、跨 mount 边界也成立），再建两个内部分支 `meebox/head` / `meebox/base` 指向 PR 的 head/base sha。
  pr-agent 的 LocalGitProvider 在这个 worktree 上算 diff（见 [04](04-pragent-runtime.md)）。
- **Diff 不 checkout 文件**：展示 diff 只需按 sha 读 blob（`git show <sha>:<path>`）+ 改动文件列表，
  不把文件 checkout 到磁盘，省 IO。Monaco 侧按文件懒加载，二进制/超大文件跳过。
- **出站代理**：打远端的 clone/fetch 按代理配置注入 env（见 [09](09-networking-proxy.md)）；本地只读操作不注入。

## 数据 / 接口契约

- **镜像路径**：`<repos_dir>/<host>/<projectKey>/<repoSlug>/bare`。
- 主要能力（对主进程）：`syncMirror(repo)`（建/增量）、`materializeWorktree(repo, headSha, baseSha)`、
  `hasCommit(repo, sha)`（预检，决定是否要 fetch）、`listChangedFiles` / `getFileContent` / `getSize` / blame。
- **进度事件**：clone/fetch 分阶段发 `start/progress/done/error`，经 IPC 推给渲染层显示同步进度。

## 扩展与注意事项

- **`simple-git` 的 `.env()` 整体替换子进程 env**：注入代理 env 时务必 merge `process.env`，否则丢 `PATH`/`HOME`。
- **LFS**：仅在需要的 worktree 实例上 opt-in 允许 unsafe filter，其余读操作保持严格模式。
- **fresh clone 后 FS 可能未 flush**（Windows 尤甚）：物化后等 git 能稳定 `rev-parse HEAD` 几次再返回，避免
  紧接着的 diff 撞上 refs/packs 不一致。
- **磁盘是大头**：仓库镜像 GB 级，`repos_dir` 可改到大盘；设置页展示总占用，提供清理。
- **二进制文件**：diff/读取要对非 UTF-8 内容安全跳过（pr-agent 侧也有对应处理，见 [04](04-pragent-runtime.md)）。
