# pr-agent run 启动开销优化笔记

> 状态：分析草稿，未实施。M5 时按需取用。
> 最后更新：2026-06-02

## 问题

同一 PR 上连续两次 `/describe` + `/review`，每次都要花 ~60s 才看到 LLM 响应行。
长 PR 评审节奏被这"固定开销"严重拖累，用户感知是"agent 在卡"。

## 60s 开销构成

按 main → pr-agent → LLM 的链路拆成四段。耗时为典型大仓库 PR (千行 diff，
Docker Desktop on Windows) 经验值。

| 阶段 | 典型耗时 | 内容 |
| --- | --- | --- |
| A · Docker 冷启动 | 3-15s | 镜像加载 → 容器创建 → WORKDIR / entrypoint。Windows Docker Desktop 偏慢 |
| B · Python 导入 + pr-agent 启动 | 5-15s | `import pr_agent / litellm / tiktoken / langchain` 等大依赖每次重跑 |
| C · worktree 准备（pr-pilot 自己做的） | 1-10s | `materializeWorktree`: bare → `git clone --local --no-checkout` + LFS bypass + 双命名分支 |
| D · pr-agent 内部预处理 | 5-30s | `get_user_description` / `get_pr_diff` (含 tiktoken 算整条 diff token) / 语言检测 |

主要矛盾在 **B + D**，但 B 极硬：每次 `docker run --entrypoint python /app/pr_agent/cli.py`
都是新 Python 进程，所有 import 重跑，不改成 daemon 模型省不掉。

## 削减方案（按 ROI 排序）

### 1. worktree 缓存（~1-2h，零风险）

同 PR 多次 run 复用同一物化 worktree。

- `materializeWorktree` → `materializeOrReuse(prLocalId, headSha, baseSha)`
- 缓存键：`(prLocalId, headSha, baseSha)`
- 命中时把 pr-agent 上次写的产物 `description.md / review.md / code_suggestions.txt`
  清掉再交回，避免上次内容污染新 run
- evict 时机：PR 切换 / 应用关闭 / headSha 变化

**节省**：第二次 run 起省 5-10s（C 段直接归零）。

### 2. PR 上下文缓存（~30min，零风险）

`buildPrContext` (拉 PR description + comments via adapter) 输出按
`(prLocalId, pr.updatedAt)` 缓存。命中条件 = updatedAt 一致；不一致重拉。

- 模块级 `Map`，应用内存生命周期
- 不持久化（PR updatedAt 一旦变就该重拉，缓存能 hit 的窗口足够短）

**节省**：第二次 run 起省 BBS API 0.3-3s（D 段的一小块）。

### 3. pr-agent 内部预处理裁剪（实测后定，~1-2h）

裁掉 D 段里不必要的步骤。候选 env：

- `CONFIG__PR_LANGUAGE_AUTO_DETECT=false` —— 跳过 PR 主语言检测
- `CONFIG__DUPLICATE_BUFFER_CHARS=0` —— 跳过 diff 缩减预处理
- `PR_REVIEWER__REQUIRE_TESTS_REVIEW=false` / `require_security_review=false` ——
  少几个评审维度，prompt 也小

**节省**：未实测；估 D 段 5-15s。每条需要单独实测验证节省幅度 + 输出质量影响。

### 4. 镜像预热（~30min，零风险）

App 启动后台执行：

```
docker pull pragent/pr-agent:0.35.0
docker run --rm pragent/pr-agent:0.35.0 python -c "pass"
```

确保镜像层 + Docker 内部缓存都已就位。

**节省**：A 段冷启 5-10s → 1-3s。
**注意**：仅对"应用启动后首次 run"有效；同一 session 后续 run 本来就是热镜像。
所以更多是"修首次体验"而非"持续节省"。

### 5. 容器长驻 + docker exec（~半天，中等复杂度）

不省 Python 导入（B 不变），但能彻底干掉 A 段的容器启动开销。

实施要点：

- App 启动时 `docker run -d --name pr-pilot-pragent -v <repos_dir>:/workspaces ... sleep infinity`
- 每次 run 用 `docker exec pr-pilot-pragent python /app/pr_agent/cli.py ...`
- worktree 必须放在预挂载根目录 `<repos_dir>` 下面（路径相对固定）
  —— 因为 `-v` 只在 `docker run` 时生效，`exec` 没法新增挂载
- worktree 管理逻辑要改：从"每次创个临时挂载点"变成"在共享挂载根下分子目录"
- 容器生命周期管理：app 退出时 stop + rm；启动检测同名残留容器

**节省**：A 段 ~80% 砍掉，每 run 省 3-10s。

### 6. pr-agent daemon 化（~1-2 天，高风险高收益）

让 Python 进程长驻，避免 B 段每次重跑。

实施要点：

- 容器 entrypoint 改成 `python -m pr_pilot.pragent_daemon`（自写的小 wrapper）
- daemon 在启动时一次性 import pr_agent + 所有依赖
- 暴露 unix socket / HTTP loopback 接受 review 请求
- 每个请求新 worker 模式（避免 pr-agent 内部全局状态污染）

**节省**：B 段 5-15s 砍到接近 0。
**风险**：
- pr-agent 不是 reentrant 设计，litellm callback 列表 / pr-agent settings singleton
  跨请求可能脏。需要每个请求重置全局状态，可能漏点
- pr-agent 升级时 daemon wrapper 跟着需要适配
- 调试链路变长（daemon 内部错误 vs pr-agent 错误）

## 推荐路径

按 1 + 2 + 4 顺序先做（合计 ~3h，零风险）。预计把"60s 固定开销"压到 30-40s 量级，
对用户体验已是显著改善。

5 / 6 留作后续大型 PR 反馈持续不佳时再上。

## 实测前置

实施 3 (env 裁剪) 之前，需要先拿 1 次真实大 PR 的完整 `/describe` stdout（带时间
戳），定位 D 段内 `get_pr_diff` / `get_user_description` / 语言检测各占几秒，再
决定优先关哪个 env。
