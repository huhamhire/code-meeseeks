# 代码平台配置

接入你的代码托管平台，客户端才能发现待评审的 PR、读 diff、发评论 / 审批 / 合并。目前支持：

- **Bitbucket Server / Data Center**（REST API v1，≥ 7.0）
- **GitHub**（github.com 与 GitHub Enterprise Server）

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
