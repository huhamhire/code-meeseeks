# 出站网络与代理

## 职责与边界

让所有**出站网络**在企业内网/受限网络下可控：开关打开后，统一经一个 **HTTP 代理**出网；
本地地址（loopback）直连。覆盖三类出口：

- **LLM 调用**（pr-agent 内嵌的 LLM 客户端）—— 首要目标，内网下没它整个评审不可用。
- **代码平台 REST**（轮询 / 评论 / 头像 / 附件 / 合并 / 连接探测）。
- **git over HTTPS**（clone / fetch）。

**不负责**：git over **SSH** 的代理——HTTP 代理对 SSH 不直接适用，跨平台也无统一手段
（macOS/Linux 有 `nc`，Windows 没有）。SSH 用户自行在 `~/.ssh/config` 配 `ProxyCommand`。

一期只支持 **HTTP 代理**（含 Basic Auth）；socks5 暂不实现，但配置上留了协议扩展位。

## 核心设计

- **单一全局代理 + loopback 直连**：开关开 → LLM、代码平台、git(HTTPS) 三类出口全走代理；
  只有 `localhost / 127.0.0.1 / ::1`（含本地 Ollama 等本地服务）自动直连。不做「按 host 选择性
  走代理」的复杂策略——用户环境里代理就是统一出网通道，简单一致。
- **配置面最小**：只暴露 开关 / 地址 / 端口 / Basic Auth（用户名、密码）。loopback 绕过是内置
  行为、不暴露。协议字段进配置但 UI 不渲染（当前仅 http），为将来加 socks5 留位——新增协议值
  对存量配置非破坏性。
- **三种注入形态，按出口取用**（这是本模块的核心）：
  - **子进程出口**（pr-agent、git）认 `HTTP(S)_PROXY` / `NO_PROXY` 环境变量 → 给子进程注入这组 env
    （`NO_PROXY` 固定含 loopback）。
  - **进程内 fetch 出口**（代码平台 REST 走 Node 的 undici fetch）**默认不认** proxy 环境变量，必须
    显式给 dispatcher（代理 Agent）→ 在构造平台客户端时，对**非 loopback** 目标包一个带代理
    dispatcher 的 fetch 注入进去；loopback / 关闭时不注入（走默认直连）。
  - 由此统一到一个中心组件，按代理配置产出以下各项，各出口只消费、不各自实现：
    - 子进程 env；
    - undici 代理 dispatcher / fetch；
    - loopback 判断；
    - 连通性自检。
- **不取费用、不联网拉价格表**：token 用量只取 API 返回值，故底层 LLM 库的远端价格表无用且会在
  弱网超时——强制只用本地价格表、彻底不联网（详见 [pr-agent 运行时](../02-agent/05-pragent-runtime.md)）。
- **热生效**：改代理配置 → 写盘 + 更新内存配置 + 重建平台 adapter（REST 即时生效）；pr-agent / git
  出口在下次操作时读最新配置，无需重启。

## 数据 / 接口契约

配置（`config.yaml` 顶层 `proxy`）：

```yaml
proxy:
  enabled: false       # 总开关；false = 全部直连，等同历史行为
  protocol: http       # 协议枚举，预留扩展；一期仅 http
  host: ''             # 代理地址
  port: 8080
  username: ''         # Basic Auth，可空
  password: ''         # 可空（明文落盘，同 config 既有策略）
```

IPC 通道：

- `config:setProxy`：入参 `{ proxy }` → 写盘 + 内存同步 + 重建 adapter（REST 即时生效）。
- `config:testProxy`：入参 `{ proxy }` → 返回 `{ ok, reason? }`，经该代理试连一个外部地址验证连通；
  代理认证失败（407）归为失败并给原因。

代理 URL 形态：`http://[username:password@]host:port`（凭据 URL 编码）。

## 扩展与注意事项

- **加 socks5**：协议枚举追加 `socks5`；undici 代理 Agent 不支持 socks，REST 出口需换成基于 socks
  建连的 dispatcher；子进程出口（pr-agent / git）的 socks 由其底层库原生支持。届时 UI 显现协议选择。
- **代理感知 fetch 的类型**：Node `fetch` 的 `dispatcher` 不在标准 `RequestInit` 类型里，注入处需类型断言。
- **替换子进程 env 时必须 merge 现有 env**：git 封装库设置 env 是整体替换，漏 merge 会丢 `PATH`/`HOME`。
- **代码平台默认随全局代理**：内网平台若被代理误伤（连不上），属边缘场景，再按需加「平台直连」开关；
  当前不做。
- **凭据明文**：代理密码与既有 config 一样明文落盘，不额外加密；面向开发者群体、文档提示风险。
