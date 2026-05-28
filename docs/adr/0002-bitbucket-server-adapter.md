# ADR-0002: Bitbucket Server / Data Center 平台适配

- **状态**：Accepted
- **日期**：2026-05-28
- **决策者**：项目主导
- **相关**：[ROADMAP §M1](../ROADMAP.md#m1--bitbucket-server-接入--pr-发现-2-周)

## 背景

一期 pr-pilot 仅支持 **Bitbucket Server / Data Center**（Atlassian 自托管版，对内网企业用户为主要场景）。

注意：Bitbucket 实际上有两个产品：

| 产品                            | API                             | 状态                 |
| ------------------------------- | ------------------------------- | -------------------- |
| Bitbucket Cloud (bitbucket.org) | REST API 2.0 (`/2.0/`)          | 在售                 |
| Bitbucket Server                | REST API 1.0 (`/rest/api/1.0/`) | 已停售，企业大量自建 |
| Bitbucket Data Center           | REST API 1.0（与 Server 兼容）  | 在售                 |

**本 ADR 仅覆盖 Server / DC（REST API v1）**，不覆盖 Cloud。后续 Cloud 支持单独立 ADR。

## 决策驱动因素

1. 一期范围明确：只对接 Bitbucket Server / DC
2. 后续要扩展 GitHub / GitLab / Gitea，必须有**统一抽象**
3. API v1 文档稳定，端点变化少
4. 不同 Server 小版本（7.x / 8.x / 9.x）的端点行为有差异，需要兼容

## 决策

### 1. 统一的 `PlatformAdapter` 抽象

```ts
interface PlatformAdapter {
  readonly kind: 'bitbucket-server' | 'github' | 'gitlab' | 'gitea';

  // 连接检测
  ping(): Promise<{ ok: boolean; serverVersion?: string; user?: string }>;

  // PR 发现
  listOpenPullRequests(repo: RepoRef, since?: Date): Promise<PullRequest[]>;
  getPullRequest(repo: RepoRef, prId: string): Promise<PullRequestDetail>;

  // Diff
  getPullRequestDiff(repo: RepoRef, prId: string): Promise<UnifiedDiff>;
  getPullRequestChangedFiles(repo: RepoRef, prId: string): Promise<ChangedFile[]>;

  // Comments
  listInlineComments(repo: RepoRef, prId: string): Promise<InlineComment[]>;
  postInlineComment(repo: RepoRef, prId: string, c: NewInlineComment): Promise<PostedComment>;
  postSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PostedComment>;

  // Git 同步用的克隆 URL（含或不含认证）
  getCloneUrl(repo: RepoRef, opts: { withAuth: boolean }): Promise<string>;
}
```

所有业务层（Poller / Publisher / Orchestrator）**只依赖此接口**，不导入具体 Adapter。

### 2. `BitbucketServerAdapter` 实现

#### 2.1 关键端点（REST API v1）

| 操作              | Method + Path                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| 当前用户          | `GET /rest/api/1.0/application-properties`（含版本） + `GET /rest/api/1.0/users/{slug}` |
| 列 PR             | `GET /rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests?state=OPEN`     |
| PR 详情           | `GET /rest/api/1.0/projects/{p}/repos/{r}/pull-requests/{prId}`                         |
| PR diff（统一）   | `GET /rest/api/1.0/projects/{p}/repos/{r}/pull-requests/{prId}/diff`                    |
| 改动文件列表      | `GET .../pull-requests/{prId}/changes`                                                  |
| 评论列表          | `GET .../pull-requests/{prId}/activities` （包含 comments）                             |
| 发表 inline 评论  | `POST .../pull-requests/{prId}/comments` body 含 `anchor: { line, lineType, path }`     |
| 发表 summary 评论 | `POST .../pull-requests/{prId}/comments` body 不含 `anchor`                             |
| 克隆 URL          | PR 详情里的 `links.clone[].href`                                                        |

#### 2.2 认证

仅支持 **Personal Access Token (PAT)**，通过 `Authorization: Bearer <token>` 发送。

- 不支持基于用户名 + 密码的 HTTP Basic（旧版兼容，但 Atlassian 已弃用）
- 不支持 OAuth（Server 上不通用，配置复杂）
- Token 通过 `SecretStore` 读取，永远不写入日志 / 异常栈

#### 2.3 分页

Bitbucket Server 用 `start` / `limit` 分页，返回 `isLastPage` / `nextPageStart`。

实现统一的 `paginate<T>(fn): AsyncIterable<T>` 助手，所有列表接口走它。默认 `limit=50`。

#### 2.4 限流

- 默认并发上限：4
- 单连接全局速率限制：可在 `config.yaml` 配置（默认无）
- 429 / 5xx 退避重试：指数退避，最多 3 次

#### 2.5 版本兼容

**支持范围硬下限：Bitbucket Server 7.0（2020 发布）**。低于此版本不支持，启动时检测到会**拒绝连接**并在设置页给出明确错误，不做妥协。

- 启动时 `ping()` 拉版本号与最低线比对
- `< 7.0`：设置页报错（"未支持的 Bitbucket Server 版本：x.y.z；最低要求 7.0"），连接置灰，不进入轮询
- `>= 7.0`：正常工作；7.x / 8.x / 9.x 之间的已知字段差异封装在 `BitbucketServerCompat`
- 决策原因：7.0 之前的实例企业占比已经极低，且 `multilineMarker` 等关键能力是 7.0 起引入的；不兜底老版本能让代码更精简、QA 矩阵更小

### 3. Diff 表示

Bitbucket Server `/diff` 返回的是平台自定义 JSON（不是标准 unified diff）。

实现 `parseBitbucketDiff()` 把平台 JSON 转成统一内部模型 `UnifiedDiff`：

```ts
interface UnifiedDiff {
  files: Array<{
    path: string;
    oldPath?: string; // rename / copy
    status: 'added' | 'modified' | 'removed' | 'renamed';
    hunks: Hunk[];
    binary: boolean;
  }>;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: 'context' | 'add' | 'del'; content: string }>;
}
```

Monaco 侧用 `UnifiedDiff`，与平台解耦。

### 4. 评论锚点映射

Bitbucket Server inline comment 的锚点用 `(path, line, lineType: 'ADDED' | 'REMOVED' | 'CONTEXT', fileType: 'TO' | 'FROM')`。

pr-pilot 内部 finding 用 `(file, startLine, endLine)`（基于 PR 目标分支视角）。需要一个映射函数把内部锚点 → Bitbucket 锚点。

- 默认锚到目标分支视角的新行（`fileType=TO`, `lineType=ADDED`）
- 删除区评论需要特别处理（`fileType=FROM`, `lineType=REMOVED`）
- 单行评论：`startLine === endLine`
- 多行评论：使用 `multilineMarker`（7.0+ 全版本支持）

## 后果

### 正面

- 业务层完全不感知 Bitbucket 细节，扩展 GitHub 时只需新增 Adapter 实现
- 兼容性差异收口在 `BitbucketServerCompat`，便于按版本调测
- Token 单一认证方式，凭据存储模型简单

### 负面

- 不兼容 < 7.0 实例（少量企业仍在用，需用户自行评估升级或寻找替代）
- `parseBitbucketDiff` 需要随 Bitbucket 输出格式变化跟进（用快照测试兜底）

### 验证（M1 之前的 API 探针）

探针脚本：[`tools/probes/bitbucket-server-probe.mjs`](../../tools/probes/bitbucket-server-probe.mjs)。

当前进度（2026-05-28，目标 `https://code.fineres.com`，server 7.17.10）：

**只读路径（已通过）：**

- [x] PAT 能 ping 通（`/application-properties`，208ms）
- [x] 列出当前用户作为 reviewer 的待处理 PR（`/dashboard/pull-requests?role=REVIEWER&state=OPEN`，跨项目跨仓库一次拿到）
- [x] 拉 PR detail（`/projects/{p}/repos/{r}/pull-requests/{prId}`）
- [x] 拉 PR diff（JSON 格式）
- [x] 拉 PR changes（改动文件，分页）
- [x] 拉 PR activities（含 comments，区分 inline / summary）

**写路径（推迟到 M4 开始前）：**

- [ ] 在测试 PR 上发 inline + summary 评论
- [ ] 评论可被列出、可删除

#### 探针发现的工程注意点

1. **`/diff` 端点会截断**：返回体含 `truncated: boolean` 字段；探针在 41 文件 / 10000 行 的真实 PR 上即触发截断。M2 实现 `parseBitbucketDiff` 必须：
   - 检测 `truncated === true`
   - 截断时改走 per-file diff（`GET .../pull-requests/{prId}/diff/{path}`）逐文件拉取
   - `contextLines` / `whitespace` 参数可调但治标不治本
2. **`/changes` 分页是常态**：单 PR 改动文件数超 50 很普遍，必须按 §2.3 `paginate<T>` 助手拉完所有页才能渲染完整文件树
3. **activities 是混合流**：`action` 字段含 `OPENED` / `UPDATED` / `COMMENTED` / `REVIEWED` / `MERGED` / `APPROVED` / `RESCOPED` 等多值，过滤 `action === 'COMMENTED'` 才是评论；`commentAnchor` 字段决定 inline 还是 summary
4. **作者字段双名**：`author.user.displayName` 是中文/真名，`author.user.name` 是英文用户 ID。UI 显示用前者，API 调用 / 用户匹配用后者
5. **`/dashboard/pull-requests` 完美匹配 Poller 场景**：跨项目跨仓库一次返回当前 PAT 用户作为 reviewer 的待处理 PR，M1 的 Poller 可直接走它，省去"先发现仓库再查 PR"的双层轮询
