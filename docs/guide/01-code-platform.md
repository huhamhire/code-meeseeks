# 代码平台配置

接入你的代码托管平台，客户端才能发现待评审的 PR、读 diff、发评论 / 审批 / 合并。目前支持：

- **GitHub**（github.com 与 GitHub Enterprise Server）
- **Bitbucket Server / Data Center**（REST API v1，≥ 7.0）
- **GitLab**（gitlab.com 与 Self-Managed，CE / EE，REST API v4，≥ 13.8，推荐 15.6+）

## 添加连接

在 **设置 → 连接**（或首启向导）新建一条连接，填写：

| 字段 | 说明 |
| --- | --- |
| 显示名 | 给人看的名字，可任意取 |
| Base URL | 平台 API 地址，见下方各平台说明 |
| 访问令牌（PAT） | 平台生成的 Personal Access Token，用于 REST API 鉴权 |
| Clone 协议 | `pat`（默认，HTTPS 内嵌令牌克隆）或 `ssh`（走系统 `~/.ssh/config`） |

> 连接可配置多条，但**同时只启用一条**进行轮询；按 id 查历史 PR 不受影响。
> 建议按最小授权配置访问令牌。连接保存后可点「测试」验证连通。

## Clone 协议

- **pat（默认）**：克隆走 HTTPS，URL 里内嵌令牌，无需额外配置。
- **ssh**：克隆走 `git@host:...`，端口 / 密钥由系统 `~/.ssh/config` 决定，**与 PAT 无关**（PAT 仅用于 REST API）。GHE / Bitbucket 自定义 SSH 端口（如 Bitbucket 默认 7999）需在 ssh config 里配好。

## 发现过滤器支持矩阵

侧栏「发现分类」标签按**活动连接的平台能力**显示——各平台原生支持的列表筛选不同，**不支持的分类不渲染对应标签**（由 `capabilities.discoveryFilters` 决定，非各处硬编码）。

| 发现过滤器 | 含义 | GitHub | Bitbucket | GitLab |
| --- | --- | :---: | :---: | :---: |
| 待我评审 | 请求我评审的 PR / MR | ✅ | ✅ | ✅ |
| 我创建的 | 我作为作者的 PR / MR | ✅ | ✅ | ✅ |
| 指派给我 | 指派给我的 PR / MR | ✅ | ❌ | ✅ |
| 提及我 | 正文 / 评论 @ 我的 PR / MR | ✅ | ❌ | ❌ |

- **GitLab**：映射到 REST API 的 `reviewer_username` / `author_username` / `assignee_username`；GitLab MR 列表无原生「提及我」筛选，故不提供该分类。
- **Bitbucket**：仅「待我评审 / 我创建的」，无「指派给我 / 提及我」。
- 新增平台时按其 API 实际支持的筛选填 `discoveryFilters`，UI 与文档随之自动对齐。

---

## 一、GitHub：Personal Access Token 权限参考

接入 GitHub（github.com 或 GitHub Enterprise Server）需要一个 **Personal Access Token (PAT)**。本节给出最小权限集。

> 连接里的 **Base URL**：github.com 填 `https://api.github.com`；GitHub Enterprise Server 填 `https://<你的 GHE 域名>/api/v3`。

### 1.1 经典 Token（Classic PAT）— 推荐

本客户端会**跨项目 / 跨仓库**轮询发现待评审的 PR，覆盖范围通常不固定。经典 token 按 scope 授权、自动覆盖你有权限的全部仓库，最契合这种用法，是本客户端的推荐方式。

适用 github.com 与 GHE Server。创建：**Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**。

勾选的 scope：

| Scope | 用途 | 何时需要 |
| --- | --- | --- |
| `repo` | 私有仓库的 PR 读写、评论、审批、合并、克隆 | 评审**私有**仓库时（最常见） |
| `public_repo` | 仅公开仓库的上述操作 | 只评审**公开**仓库时（替代 `repo`） |
| `read:user` | 读取当前用户信息（`/user`） | 可选；多数情况无需单独勾也能用 |

**评审私有仓库 → 勾 `repo` 即可**；只评审公开仓库 → 勾 `public_repo`。

> **组织开启了 SAML SSO**：生成 token 后，需在 token 页面点 **Configure SSO / Authorize** 为对应组织授权，否则访问该组织仓库会 403。

### 1.2 细粒度 Token（Fine-grained PAT）— 仅适合固定仓库集

细粒度 token 必须**逐个枚举授权仓库**，权限更细、更安全，但需要预先固定仓库范围——与本客户端跨项目轮询的用法不太契合（新增项目 / 仓库都要回去补授权）。**仅当你只评审固定的少数仓库**时适合用它；否则建议用上面的经典 token。

创建：**Settings → Developer settings → Personal access tokens → Fine-grained tokens**。

- **Repository access**：选择你要评审的仓库（或某组织下全部）。
- **Repository permissions**（仓库权限）：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Metadata | Read（强制，自动包含） | 基础元数据 / 仓库可见 |
| Pull requests | **Read and write** | 列 PR、读评论、发行内 / 普通评论、回复 / 编辑 / 删除、提交审批（通过 / 需修改 / 撤销） |
| Contents | **Read and write** | 克隆仓库（read）+ **合并 PR**（merge 写目标分支，需 write） |
| Checks | Read（可选） | 让「可合并状态」更准确（识别必需检查未通过） |
| Commit statuses | Read（可选） | 同上，识别 status 检查 |

最小可用集：**Pull requests: RW + Contents: RW + Metadata: R**。
只读不合并也不发评论的话，可降到 Pull requests / Contents 均为 Read（但本客户端的评论 / 审批 / 合并会不可用）。

> 细粒度 token 在 **GitHub Enterprise Server** 上的可用性随版本而定；较老的 GHE 只支持经典 token——这种情况用上面的 Classic PAT（`repo`）。

### 1.3 按客户端操作对应的权限速查

| 客户端操作 | 端点 | Classic | Fine-grained |
| --- | --- | --- | --- |
| 发现待我评审的 PR | `GET /search/issues` | repo / public_repo | Pull requests: R |
| 读 PR / 评论 / 提交 | `GET /pulls`、`/issues/{n}/comments`、`/pulls/{n}/commits` | 同上 | Pull requests: R（+ Contents: R 取提交） |
| 发 / 改 / 删 评论、回复 | `POST/PATCH/DELETE …/comments` | 同上 | Pull requests: **RW** |
| 审批（通过 / 需修改 / 撤销） | `POST …/reviews`、`PUT …/reviews/{id}/dismissals` | 同上 | Pull requests: **RW** |
| 合并 PR | `PUT …/pulls/{n}/merge` | 同上 | Contents: **RW** |
| 克隆仓库（本地 diff） | git over HTTPS（PAT） | 同上 | Contents: **R** |
| 头像 / 评论内嵌图片 | 资源 URL（带 token） | 同上 | 无需额外 |

### 1.4 注意事项

- **不能审批自己创建的 PR**：GitHub 限制（会 422）。客户端已对自己作者的 PR 灰显审批按钮。
- **合并需要 Contents 写权限**：仅给 Pull requests 写而漏了 Contents 写时，评论 / 审批可用但合并会失败。
- **SSH 克隆**：连接的 Clone 协议选 SSH 时，走系统 `~/.ssh/config`，与 PAT 无关（PAT 仅用于 REST API）。
- **限流**：发现走 GitHub Search（约 30 次/分钟），客户端会按平台节流。
- **安全**：按最小必要范围授权，离职 / 泄露时及时吊销。

---

## 二、Bitbucket Server / Data Center

- **Base URL**：填服务器根地址，如 `https://bitbucket.your-company.com`。
- **访问令牌**：在 Bitbucket 个人设置 → **HTTP access tokens（个人访问令牌）** 创建。
- **权限**：授予目标项目 / 仓库的 **Repository: Write**（写含读）。
  - 只读评审（不评论 / 不合并）可降到 **Repository: Read**，但客户端的评论 / 审批 / 合并将不可用。
  - 合并 PR 需要仓库写权限。
- **克隆 URL 形态**：pat → `https://<user>:<PAT>@host/scm/<proj>/<repo>.git`（用户名取当前登录用户）；ssh → `git@host:<proj>/<repo>.git`。

---

## 三、GitLab（gitlab.com / Self-Managed，CE / EE）

接入 GitLab（gitlab.com 或自建 Self-Managed 实例）需要一个 **Personal Access Token (PAT)**。本节给出最小权限集。

> 连接里的 **Base URL**：gitlab.com 填 `https://gitlab.com/api/v4`（留空即默认此值）；Self-Managed 填 `https://<你的 GitLab 域名>/api/v4`。

创建：**右上角头像 → Edit profile → Access Tokens**（或 `User Settings → Access Tokens`）→ Add new token，勾选 scope 并设置有效期。

> **版本兼容**：接入走 GitLab REST API v4，覆盖 gitlab.com SaaS 与 Self-Managed（CE / EE）。
> - **推荐 GitLab 15.6 及以上**：`/metadata`（15.2+）自动探测 edition、`detailed_merge_status`（15.6+）令可合并状态 full 保真，体验最完整。
> - **最低 GitLab 13.8**：「待我评审」发现依赖 MR Reviewers 的 `reviewer_username` 筛选（13.8 起提供）；更低版本该过滤不可用，可改用「我创建的 / 分配给我的」发现过滤。
> - **13.8 ~ 15.5 自动降级**：缺 `/metadata` 退回 `/version`（保守按 CE、审批 UI 灰显），缺 `detailed_merge_status` 退回 `merge_status`（可合并判断略粗）；发现 / 评论 / 合并 / clone 均正常。
> - **审批（通过 / 撤销）**：属 EE Premium / Ultimate（MR 审批 API 自 13.9），经 edition 探测启用，CE 灰显，详见下文 3.2。

### 3.1 Scope（最小授权）

GitLab PAT 按 scope 授权，自动覆盖你有权限的全部项目，契合本客户端跨项目轮询发现 MR 的用法。

| Scope | 用途 | 何时需要 |
| --- | --- | --- |
| `api` | 完整 REST API 读写：MR 发现、读 / 发 / 改 / 删评论与回复、审批（EE）、合并 | 需要评论 / 审批 / 合并时（最常见，**推荐**） |
| `read_api` | 只读 REST API | 仅浏览（不评论 / 不审批 / 不合并）时，替代 `api` |
| `read_repository` | Git-over-HTTPS 克隆 / 拉取私有项目 | Clone 协议为 `pat` 且 token 只给了 `read_api` 时补上 |

**推荐：单勾 `api`**——它已涵盖 REST API 写操作与 HTTPS 克隆，最省心。
只读浏览：`read_api` +（pat 克隆再加）`read_repository`。

### 3.2 CE / EE 审批差异

GitLab 的 MR 审批 API（`approve` / `unapprove`）自 13.9 起属 **Premium / Ultimate（EE 付费版）** 功能，且 GitLab 审批是二元的——**只有「通过 / 撤销」，无「需修改」**。

- 客户端经 `/metadata` 探测实例 edition，据此降级审批能力：
  - **EE（Premium 及以上）**：审批按钮可用（通过 / 撤销）。
  - **CE / 社区版**：无审批 API，审批按钮 **灰显不可用**；发现 / 评论 / 合并照常。
- 可合并状态走 `detailed_merge_status`，对合并阻塞原因（冲突 / 待审批 / 流水线未过等）full 保真展示。

### 3.3 按客户端操作对应的权限速查

| 客户端操作 | 端点 | 所需 scope |
| --- | --- | --- |
| 发现待我评审的 MR | `GET /merge_requests?reviewer_username=…` | `read_api` / `api` |
| 读 MR / 评论（discussions） | `GET …/merge_requests/{iid}`、`/discussions` | `read_api` / `api` |
| 发 / 改 / 删评论、回复 | `POST/PUT/DELETE …/discussions[/notes]` | `api` |
| 审批（通过 / 撤销，仅 EE） | `POST …/approve`、`/unapprove` | `api` |
| 合并 MR | `PUT …/merge` | `api` |
| 克隆仓库（本地 diff） | git over HTTPS（PAT） | `read_repository`（或 `api`） |
| 头像 / 评论内嵌图片 | 资源 URL（带 token） | 无需额外 |

### 3.4 注意事项

- **克隆 URL 形态**：pat → `https://<user>:<PAT>@host/<group>/<repo>.git`（用户名取当前登录用户，支持嵌套 group）；ssh → `git@host:<group>/<repo>.git`。
- **嵌套 group**：路径含多级 group（如 `group/subgroup/proj`）已正确解析。
- **审批自己的 MR**：受项目「阻止作者审批」等服务端设置约束，按 GitLab 规则裁决，客户端透传 API 结果。
- **SSH 克隆**：Clone 协议选 SSH 时走系统 `~/.ssh/config`，与 PAT 无关（PAT 仅用于 REST API）。
- **安全**：按最小必要 scope 授权并设置有效期，离职 / 泄露时及时吊销。
