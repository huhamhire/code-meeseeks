# 01 · 代码平台适配

## 职责与边界

把「代码托管平台」的差异收口到一个统一抽象 `PlatformAdapter`，业务层（轮询、镜像、发布）
只依赖该接口、不感知具体平台。当前仅实现 **Bitbucket Server / Data Center**（REST API v1，≥ 7.0）；
GitHub / GitLab 为后续扩展点。

不负责：git 本地操作（见 [02](02-repo-mirror.md)）、pr-agent 调用（见 [04](04-pragent-runtime.md)）。

## 核心设计

- **统一抽象 `PlatformAdapter`**：一个接口覆盖连接探测、PR 发现、评论读写、合并、克隆 URL、头像/附件。
  新增平台＝新增一个实现，业务层零改动。
- **平台中性的 PR 身份 `PrIdentity`**：`platform / group / repo / remoteId / connectionId`（+ 可选 url）。
  各平台把自己的概念映射进来（Bitbucket：group=projectKey、repo=repoSlug、remoteId=PR id）。这套身份
  也是状态存储 hash localId 的输入（见 [03](03-state-storage.md)）。
- **认证只用 PAT**：`Authorization: Bearer <token>`。不支持 Basic / OAuth。token 经凭据层读取，绝不进日志。
- **PR 发现走「dashboard」聚合端点**：一次拿到「当前 PAT 用户作为 reviewer 的全部待处理 PR」（跨项目跨仓库），
  省掉「先列仓库再查 PR」的双层轮询。
- **clone 协议二选一**：`pat`（默认，`https://<user>:<PAT>@host/...`）或 `ssh`（`git@host:...`，走系统 ssh 配置）。
  克隆 URL 由 adapter 产出，交给镜像层。
- **REST 客户端可注入 fetch**：底层 HTTP 客户端暴露 `fetch` 注入口，用于挂代理 dispatcher（见 [08](08-networking-proxy.md)）
  与测试桩；默认用全局 fetch。
- **版本下限 7.0**：`ping()` 读服务端版本，低于 7.0 拒绝连接并在设置页报错（multilineMarker 等关键能力 7.0 起）。
- **分页 / 限流**：列表端点统一 `start/limit` 分页迭代器；并发上限 + 429/5xx 指数退避重试。

## 数据 / 接口契约

`PlatformAdapter`（当前形态，全部平台中性）：

- 连接：`ping()`（版本 + 用户）、`getCurrentUser()`（同步读 ping 缓存的当前用户，判 approved 用）。
- 发现：`listPendingPullRequests()`（reviewer 待处理，跨仓）。
- 读：`listPullRequestComments()`、`listPullRequestCommits()`（newest-first）、`getUserAvatar(slug)`、
  `getAttachment(url, repo?)`（评论内嵌图片代理）。
- 写：`setPullRequestReviewStatus()`、`mergePullRequest()`、`publishInlineComment()`、`replyToComment()`、
  `editComment()`、`deleteComment()`。
- git：`getCloneUrl(repo)`（按 clone 协议返回）。

> 评论锚点：内部 finding 用 `(path, startLine, endLine)`（目标分支视角），发布时映射成平台锚点
> （Bitbucket：`anchor{path, line, lineType, fileType}`，多行用 multilineMarker）。

`Diff` 不走 adapter 抓取：Diff 展示由本地镜像 `git` 算（见 [02](02-repo-mirror.md)），与平台解耦。

## 扩展与注意事项

- **加 GitHub/GitLab**：实现 `PlatformAdapter` + 在 `PrIdentity` 映射里落 `platform`/`group`/`repo`；
  发现/评论/合并端点各自实现，其余层不变。建议先补一套 adapter 一致性测试套件再开新平台。
- **写路径有副作用**：合并不可逆、评论发布要幂等（发布成功落远端 id 防重发，见 [05](05-review-workflow.md)）。
- **作者字段双名**：展示名（中文/真名）与登录名（英文 id）要分清——展示用前者，匹配「当前用户」用后者。
- **diff 端点会截断**：平台 `/diff` 大 PR 返回 `truncated`，故 Diff 一律走本地 git，不依赖平台 diff 端点。
