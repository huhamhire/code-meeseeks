# ADR-0003: 状态存储与工作目录布局

- **状态**：Accepted
- **日期**：2026-05-28
- **决策者**：项目主导
- **取代**：ROADMAP 早期草案中 SQLite + 固定 `~/.pr-pilot/` 假设；2026-05-28 进一步收窄："仅 `repos_dir` 可配置"

## 背景

ROADMAP 初稿使用：

- **状态存储**：SQLite（better-sqlite3），含 `pull_requests` / `review_runs` / `findings` / `comment_drafts` 等表
- **目录布局**：所有数据固定在 `~/.pr-pilot/`，含独立的 `secrets.yaml` 存 token

Review 反馈四点：

1. 单用户本地工具规模不大（最多数百 PR、数千 findings），SQLite + native binding 是否过度
2. 仓库镜像可能很大（GB 级），强制放 home 路径会挤爆系统盘
3. config + secrets 拆两个文件徒增心智成本，一期可合并
4. 工作目录只需要让"大头"——仓库镜像——可配置即可，没必要让整个 workspace 可搬迁

## 决策驱动因素

1. **复杂度匹配规模**：M5 之前数据量都很小
2. **打包成本**：better-sqlite3 是 native 模块，每个 Electron 版本要重编译，CI 三平台矩阵很麻烦
3. **磁盘占用可控**：用户应当能把"大头"放到其他磁盘
4. **可调试性**：状态文件最好能用文本编辑器看
5. **预留升级路径**：将来真的需要 SQLite，应当只换实现不换接口
6. **启动逻辑简单**：固定路径下无需 locator / 引导页

## 决策

### 1. 状态存储用 JSON 文件，封装在 `StateStore` 接口后

```ts
interface StateStore {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, data: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<string>;
}
```

一期实现 `JsonFileStateStore`：

- 每个 key 对应一个 JSON 文件，相对 `state/` 根目录
- 写入用 "写 tmp 文件 → fsync → rename" 原子模式，避免崩溃中产生半截文件
- 单写者：Electron Main 进程独占，无需文件锁
- 拆分原则（详见 ROADMAP §4）：
  - 频繁读写 + 体积小 → 单文件聚合
  - 单条体积大 / 写入独立 → 每实例一文件（如每次 review run）
- 所有文件含 `schema_version` 字段，便于后续迁移

何时升级到 SQLite：

- 单 JSON 文件超过 10 MB 频繁读写
- 跨实体查询变复杂（"找过去 7 天 finding 数 > 5 的 PR"）
- 出现可测的性能瓶颈

升级时只换 `StateStore` 实现，业务层不变。

### 2. 工作目录布局：固定应用目录 + 可配置 repos 位置

**核心原则**：应用数据（config、state、logs、rules）固定在 `~/.pr-pilot/`，跨 OS 一致；仅仓库镜像存储位置 `repos_dir` 允许用户配置。

**固定位置**：`~/.pr-pilot/`

```
~/.pr-pilot/
├── config.yaml      # 全部配置（含 token + repos_dir 设置），权限 600 / Windows ACL
├── rules/
├── state/           # JSON 状态文件
└── logs/
```

**可配置位置**：`repos_dir`（默认 `~/.pr-pilot/repos/`，通过 `config.yaml` 设置）

```yaml
# config.yaml 片段
workspace:
  repos_dir: D:\pr-pilot-repos   # 默认值是 ~/.pr-pilot/repos
```

```
<repos_dir>/
└── <host>/<owner>/<repo>/
    ├── <bare>/      # partial clone 镜像
    └── worktrees/<pr-id>/
```

**为什么只让 `repos_dir` 可配置**：

- 仓库镜像是唯一的磁盘占用大头（GB 级），用户可能要放到大盘 / 外置盘 / 非 home 卷
- config / state / logs 总量极小（< 100 MB），固定路径反而便于备份和定位，跨 OS 体验一致
- 不需要 locator 文件，启动逻辑直接读固定路径
- 没有"用户首次启动得选位置"的引导页，开机即用

**首次启动**：

1. `~/.pr-pilot/` 不存在 → 创建目录 + 写入默认 `config.yaml`（`repos_dir` 留默认值 `~/.pr-pilot/repos/`）
2. 无需用户介入，应用直接进入主界面

**修改 `repos_dir`**（设置页操作）：

1. 用户在设置页指定新路径
2. 应用挂起所有持有 repo 文件句柄的操作（poller / mirror）
3. 选择策略：
   - **移动**：把现有 `repos/` 移动到新位置（同卷 rename，跨卷 copy + verify + delete）
   - **重建**：保留旧目录，从空开始；下次轮询时按需重新 clone
4. 写入新 `repos_dir` 到 `config.yaml`
5. 解除挂起或重启进程

失败时回滚：`config.yaml` 不更新；已部分移动的数据保留在原位置。

### 3. config + secrets 合并

一期只用单个 `config.yaml`：

```yaml
# config.yaml 示意
workspace:
  repos_dir: ~/.pr-pilot/repos     # 唯一可改的存储位置
  rules_dir: ./rules
  logs_dir: ./logs

poller:
  interval_seconds: 300

connections:
  - id: bb-internal
    kind: bitbucket-server
    base_url: https://bitbucket.internal.corp/
    display_name: 内部 Bitbucket
    auth:
      type: pat
      token: <bitbucket PAT>          # ← 敏感

llm:
  provider: openai-compatible
  base_url: https://api.openai.com/v1
  model: gpt-4o
  api_key: <api key>                  # ← 敏感
```

但代码层保持 `SecretStore` 抽象，所有 token / key 读写经过它，不直接 `fs.readFile`：

```ts
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class ConfigFileSecretStore implements SecretStore { /* 一期 */ }
// 未来：class KeytarSecretStore implements SecretStore { ... }
```

这样未来切到 keytar / OS Keychain 时，只需替换 `SecretStore` 注入实现，业务代码零改动。

## 后果

### 正面

- M1 起步成本下降：没有 better-sqlite3 native 编译，没有 schema migration 框架
- 用户能直接打开 JSON 文件看自己的状态（调试友好）
- 启动无引导页，开机即用
- 仓库占用过大问题用户自管：改 `repos_dir` 到大盘即可
- `StateStore` / `SecretStore` 抽象让 SQLite / keytar 是平滑升级而非破坏性变更
- 配置文件单一，用户认知简单

### 负面

- 没有事务，跨文件一致性靠应用层小心（接受：场景简单，单写者）
- JSON 文件大到一定程度后读写延迟会暴露（监控 + 提前升级 SQLite）
- 用户改 `repos_dir` 后需要重启或挂起 poller（接受：低频操作）
- 凭据混在 `config.yaml` 里：文档必须明示风险，文件权限设置必须可靠（Windows ACL 写起来比 Unix chmod 复杂）
- `~/.pr-pilot/` 不可迁移：用户家目录所在盘空间紧张时只能手工腾挪（接受：config/state/logs 总量小）

### 监控指标（M3 之后埋点）

- 各 JSON 文件大小，超 5 MB 警告
- `repos_dir` 总占用，每个 repo 占用 Top N
- atomic rename 失败率
- 启动时 `~/.pr-pilot/` 读取/创建失败率
