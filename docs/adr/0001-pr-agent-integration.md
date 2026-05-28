# ADR-0001: pr-agent 集成方式

- **状态**：Accepted
- **日期**：2026-05-28
- **决策者**：项目主导
- **相关**：[ROADMAP §M3](../ROADMAP.md#m3--pr-agent-集成-2-周核心)

## 背景

[Qodo pr-agent](https://docs.pr-agent.ai/) 是 Python 项目（PyPI 包 `pr-agent`，官方镜像 `codiumai/pr-agent`），提供 `describe` / `review` / `improve` / `ask` 等子命令，输入 PR URL + token，输出 Markdown 评论。

pr-pilot 是 Electron + Node + TypeScript 应用。两者技术栈不同，必须确定一个稳定的集成方式。

约束：

- 用户机器**不一定预装 Python**，但**大多数会装 Docker** 或愿意装 Python。
- 升级 pr-agent 应当**对 pr-pilot 主体代码零影响**。
- 输入和输出必须**可在 Node 侧结构化处理**（不止是把 Markdown 贴回去）。
- 一期可接受"启动 1–3 秒"的冷启动延迟。

## 决策驱动因素

1. **可维护性**：能否轻松跟上 pr-agent 上游版本。
2. **部署门槛**：用户安装的复杂度。
3. **可控性**：能否注入自定义规则、捕获错误、解析输出。
4. **性能**：单次 review 的端到端延迟。
5. **跨平台**：Windows / macOS / Linux 表现一致。

## 候选方案

### A. 本地 CLI 子进程（每次 spawn）

`pr-agent` 装在用户的 Python 环境中，pr-pilot 通过 `child_process.spawn('pr-agent', [...])` 调用。

- ✅ 实现简单，进程隔离干净
- ✅ 升级 pr-agent 只需 `pip install -U`
- ✅ 失败模式清晰（exit code + stderr）
- ❌ 用户需要管理 Python 环境（venv / pipx）
- ❌ 每次冷启动有 Python 解释器开销（1–2 秒）

### B. Docker 容器

通过 `docker run --rm -v <repo>:/repo codiumai/pr-agent ...` 调用。

- ✅ 无需用户管 Python 依赖
- ✅ 版本锁定容易（镜像 tag）
- ❌ 用户需要装并启动 Docker
- ❌ 启动比 A 更慢（容器创建 + volume mount）
- ❌ Windows 上需要 WSL2 + Docker Desktop（不是所有用户都有）

### C. 长驻 HTTP/WS sidecar

把 pr-agent 包成本地 HTTP 服务（FastAPI 简单封一层），pr-pilot 通过 HTTP 调用。

- ✅ 冷启动只付一次代价
- ✅ 可流式输出（SSE / WS）
- ❌ 需要进程生命周期管理（启停 / 健康检查 / 端口冲突）
- ❌ 需要自维护一层 sidecar 代码，增加上游升级负担
- ❌ M1/M2 阶段没有这个性能压力，过度设计

### D. 用 TypeScript 重写 pr-agent 关键逻辑

把 pr-agent 的 prompt + 编排逻辑用 TS 重写，pr-pilot 直接调 LLM API。

- ✅ 单一技术栈，打包最简单
- ❌ 完全脱离 pr-agent 上游，要自己跟进所有改进
- ❌ pr-agent 的工具集（compress、token 管理、多模态等）需重做
- ❌ 违背"基于 pr-agent 构建"的项目定位

## 决策

**采用方案 A（本地 CLI）为主，方案 B（Docker）作为 fallback。**

封装成策略模式 `PrAgentBridge`：

```ts
interface PrAgentBridge {
  describe(input: ReviewInput): Promise<DescribeOutput>;
  review(input: ReviewInput): Promise<ReviewOutput>;
  version(): Promise<string>;
}

class LocalCliStrategy implements PrAgentBridge {
  /* spawn pr-agent */
}
class DockerStrategy implements PrAgentBridge {
  /* spawn docker run codiumai/pr-agent */
}
```

启动时探测顺序：

1. `pr-agent --version` → 有则用 LocalCli
2. `docker --version` → 有则用 Docker
3. 都无 → 设置页报错并给安装指引（pipx / Docker Desktop）

用户可在设置页强制指定策略，覆盖自动探测。

### 关键实现约定

- **输入传递**：通过 stdin + 临时 YAML 配置文件，不通过命令行参数（避免参数注入和长度限制）
- **工作目录**：每次调用切到对应 PR 的 worktree（M2 创建）
- **输出格式**：优先使用 pr-agent 的 `--output-format=json`（若可用）；不可用则解析 Markdown
- **超时**：单次调用默认 5 分钟超时，可配置
- **错误分类**：区分"配置错误"（token / LLM key 错）、"PR 错误"（不存在 / 无权限）、"运行错误"（pr-agent 内部异常）

### Docker 模式的额外约定

- 镜像版本固定到具体 tag（不用 `:latest`）
- volume mount 仓库 worktree（只读）和临时输出目录（可写）
- token / LLM key 通过 `--env-file` 临时文件传入，运行后删除

## 后果

### 正面

- 用户两条路都能跑（pipx / Docker），覆盖面广
- pr-agent 升级 = 改一个版本号，不需要改 pr-pilot 业务代码
- 失败模式简单（进程 exit + stderr），易诊断

### 负面

- 每次 review 有 1–3 秒冷启动，M5 之前不优化
- 需要在 CI 上同时测两种策略（增加 CI 矩阵）
- 设置页要写一套"我的环境是否就绪"诊断 UI

### 后续可能升级

- 若发现 M3/M4 性能成为痛点，可在 M5 加方案 C（HTTP sidecar）作为第三种策略，**不替换** A/B
- 若 pr-agent 上游提供官方 Node 客户端 / npm 包，再考虑迁移
