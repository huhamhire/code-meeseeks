# 07 · 配置与凭据

## 职责与边界

统一管理应用配置与敏感凭据：单一 `config.yaml`（连接、LLM、规则、轮询、代理等）+ 凭据抽象 +
设置页可视化编辑 + 首启向导。

负责：配置 schema、读写与热更新、凭据存取抽象、设置 UI。不负责：各子系统怎么用这些配置（见对应分篇）。

## 核心设计

- **单一 `config.yaml`（含敏感字段）**：配置与凭据合并在一个文件，不拆 `secrets.yaml`（减心智）。文件权限
  收紧（Unix 600 / Windows ACL）。**应用数据目录固定** `~/.code-meeseeks/`（config/state/logs/），仅
  `workspace.repos_dir` 可改（见 [03](03-state-storage.md)）。
- **schema 用 zod 定义 + 全字段默认值**：解析时缺字段补默认，老配置自动兼容、新增字段非破坏性。顶层含：
  `connections[]` + `active_connection_id`、`llm{profiles[], active_id}`、`rules{dir,enabled}`、`poller{interval_seconds}`、
  `proxy{...}`（见 [08](08-networking-proxy.md)）、`pr_agent{strategy}`（见 [04](04-pragent-runtime.md)）、
  `workspace{repos_dir}`、`language`。
- **凭据抽象 `SecretStore`**：所有 token / API key 读写经它，不直接 `fs`。一期实现把凭据存在 `config.yaml`
  （`ConfigFileSecretStore`）；预留 keytar/OS Keychain 实现，将来只换注入、业务零改动。凭据**绝不进日志/异常栈**。
- **多套 LLM 预设（profiles）**：`llm.profiles[]` 每条独立 `provider / model / base_url / api_key`，`active_id`
  切当前生效。内置 provider 选项（openai / openai-compatible / deepseek / anthropic / dashscope /
  volcengine-ark / cli）；按 provider 决定注入哪族 env（见 [04](04-pragent-runtime.md)）。本地 Ollama
  经 openai-compatible 的 `/v1` 端点接入（旧 `ollama` 值自动迁移）。
- **热更新（写盘 + 内存同步）**：每个设置项保存时写 `config.yaml` **并**更新内存中的 config，必要时热重建
  受影响运行时（如连接/代理变更重建 adapter、轮询间隔热替换定时器），无需重启。
- **设置页可视化 CRUD**：连接、LLM 预设、代理、规则目录、轮询间隔、`repos_dir` 都能在设置页编辑；
  连接/LLM 有「测试」入口（ping / 代理连通）。也提供「用系统关联程序打开 config.yaml」直接编辑（适合高级用户，
  减少冗余 UI）。
- **首启配置向导**：首次启动自动建 `~/.code-meeseeks/` + 默认 `config.yaml`；引导配代码平台连接（+ 可选 LLM），
  最快路径进入可用状态。

## 数据 / 接口契约

- `config.yaml` 顶层（节选）：`connections` / `active_connection_id` / `llm{profiles,active_id}` / `rules` /
  `poller` / `proxy` / `pr_agent` / `workspace.repos_dir` / `language`。
- `SecretStore`：`get(key)` / `set(key,value)` / `delete(key)`。
- 设置相关 IPC：分项 `config:setConnections` / `config:setLlm` / `config:setProxy` / `config:setRules` /
  `config:setPoller` / `config:setReposDir`，以及 `config:read` / `config:testConnection` / `config:testProxy` /
  「打开 config 文件」等；保存即热生效。

## 扩展与注意事项

- **凭据明文落盘**：当前安全模型——文件权限收紧 + 文档提示风险；面向开发者群体可接受。切 keytar 时只换
  `SecretStore` 实现。
- **配置向后兼容**：加新字段务必带默认值（zod `.default`），并考虑旧形态迁移（如 LLM 从单配置迁到 profiles 的兼容）。
- **`repos_dir` 改动**是低频操作，可能需重启/挂起轮询。
- `~/.code-meeseeks/` 不可迁移（仅 `repos_dir` 可搬到大盘）；config/state/logs 总量小，固定路径便于备份定位。
