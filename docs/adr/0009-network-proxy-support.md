# ADR-0009: 出站网络代理支持（HTTP 代理，统一配置）

- **状态**：Accepted（已实现 ①②③ + 设置页 + IPC；④ 文档引导）
- **日期**：2026-06-06
- **决策者**：项目主导
- **相关**：[ADR-0001](./0001-pr-agent-integration.md)（pr-agent 集成）、[ADR-0002](./0002-bitbucket-server-adapter.md)（Bitbucket Server adapter）、[ADR-0008](./0008-pragent-packaging-and-runtime.md)（嵌入式运行时 / 子进程 env）、[ROADMAP](../ROADMAP.md)

## 背景

目标用户多在**企业内网**：访问自建 Bitbucket Server 走内网直连，但调用外部 LLM（DeepSeek / 阿里百炼 / OpenAI 等）往往**必须经过公司 HTTP 代理**才能出公网。当前实现对所有出站连接都是直连，没有任何代理配置入口 —— 内网用户无法让 **pr-agent 的 LLM 调用**出网，这是阻断性的。

其中 **pr-agent 的 LLM 调用**是首要目标（不走代理就完全不可用）；**Bitbucket Server REST / git** 也一并走代理（用户环境里代理是统一的出网通道）。

因此本设计采用**单一全局 HTTP 代理**模型：开关打开后，**所有外部出口（LLM ①、Bitbucket Server REST ②、git HTTPS ③）统一走代理**；只有 **loopback / 本地服务**（如本地 Ollama）自动直连，**SSH** 走用户自配（见 §2 / §4）。配置面只暴露代理地址 / 端口 / Basic Auth，用户只填一个代理地址、无需理解绕过清单。

### 现状：出站网络出口盘点（4 处）

| # | 出口 | 实现 | 当前代理支持 |
| --- | --- | --- | --- |
| ① | **pr-agent LLM 调用** | 嵌入式 python 子进程（litellm → httpx），spawn 见 [exec.ts](../../packages/pr-agent-bridge/src/exec.ts)，env 在 [ipc.ts](../../apps/desktop/src/main/ipc.ts) 由 [buildPragentEnv](../../apps/desktop/src/main/utils/agent.ts) 拼出 | 无（但子进程继承 `process.env`，httpx 认 `HTTP(S)_PROXY`） |
| ② | **Bitbucket Server REST**（轮询/评论/头像/附件/合并/ping） | [BBClient](../../packages/platform-bitbucket-server/src/client.ts) 用全局 `fetch`（undici） | 无（Node `fetch` 默认不认 proxy env，须给 dispatcher） |
| ③ | **git clone/fetch（HTTPS+PAT）** | `simple-git` shell 调 `git`，clone URL = `https://user:pat@host/...`（[adapter.ts getCloneUrl](../../packages/platform-bitbucket-server/src/adapter.ts)） | 无（git 原生认 `http.proxy` / `https_proxy`） |
| ④ | **git clone/fetch（SSH）** | `cloneProtocol: 'ssh'` → `git@host:...`，走系统 ssh | 无（HTTP 代理对 SSH 不直接适用，须 `ProxyCommand`） |

> 另有**构建期**出口（[assemble-pragent-runtime.mjs](../../apps/desktop/scripts/assemble-pragent-runtime.mjs) 下载 CPython + `pip install`），已自带 `configureProxy()`（undici ProxyAgent + 认 `HTTP(S)_PROXY`/`ALL_PROXY`/`--proxy`）。它是构建期、跟运行时配置独立，本 ADR 不动它，仅作为实现参考。

## 决策驱动因素

- **pr-agent LLM 出口优先**：内网用户没它就完全不可用。
- **统一出网**：开关打开后 LLM、Bitbucket Server、git HTTPS 都经代理，单一出网通道、行为一致。
- **本地服务不被误伤**：loopback / 本地（如本地 Ollama）应始终直连，不经代理。
- **配置面最小**：只暴露 HTTP 代理的地址 / 端口 / Basic Auth，其余（绕过清单、协议、socks 等）不暴露，降低用户心智与误配。
- **跨平台**：Windows x64 + macOS arm64 都要成立（SSH 代理在这点上最难）。
- **可控、可关、可测**：开关 + 「测试连通」反馈。

## 决策

### 1. 配置形状（config.yaml，[ConfigSchema](../../packages/shared/src/config.ts) 加顶层 `proxy`）

**一期只支持 HTTP 代理；UI 只暴露 地址 / 端口 / Basic Auth：**

```yaml
proxy:
  enabled: false # 总开关；false 时全部直连，等同现状
  protocol: http # 协议枚举，预留扩展；一期仅 http
  host: '' # 代理服务器地址，例 proxy.corp / 127.0.0.1
  port: 8080 # 代理端口
  username: '' # Basic Auth 用户名（可空 = 无鉴权）
  password: '' # Basic Auth 密码（可空）
```

```ts
// packages/shared/src/config.ts
export const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  // 协议枚举，预留后续扩展（socks5 等）。一期仅 'http'；新增值对存量 http 配置非破坏性。
  protocol: z.enum(['http']).default('http'),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(8080),
  username: z.string().default(''),
  password: z.string().default(''),
});
// ConfigSchema 内：proxy: ProxySchema.default({})
```

**为何把 `protocol` 放进 schema 但 UI 暂不暴露**：留一个稳定的扩展位，将来加 `socks5` 只需往 enum 追加一个值 + 对应 dispatcher，**不改配置结构、不破坏存量配置**；在只有一个合法值时 UI 不渲染该选项，保持配置面最小。
**不暴露**：协议（schema 里有但固定 http、UI 不渲染）、绕过清单（自动推导，见 §2）。
内部按 `protocol` 拼标准代理 URL：`<protocol>://[username:password@]host:port`，供下游各出口消费。

### 2. 自动绕过：仅 loopback / 本地服务，不暴露

绕过清单不让用户填。开关打开后外部出口一律走代理，**只有 loopback / 本地地址自动直连**：

- `localhost` / `127.0.0.1` / `::1`，以及配置里指向本地的服务（如本地 Ollama 的 `base_url=http://127.0.0.1:11434`）。
- 经 `NO_PROXY=localhost,127.0.0.1,::1`（+ 本地 Ollama host）实现；子进程 env、undici dispatcher、git 共用同一份判断。

好处：用户只配一个代理地址；本地服务（Ollama / 本地 git）不被误经代理；Bitbucket Server / LLM 等外部 host 统一走代理，行为一致。

### 3. 中心化 plumbing：一个 helper，产出三种形态

新增 `apps/desktop/src/main/utils/proxy.ts`，读 `config.proxy`，对外暴露：

```ts
proxyUrl(proxy): string | undefined                 // http://[user:pass@]host:port；enabled=false → undefined
shouldBypass(host): boolean                          // 命中 loopback/本地 → true
buildProxyEnv(proxy): Record<string,string>         // (a) 子进程 env：HTTP_PROXY/HTTPS_PROXY/NO_PROXY（大小写都给），NO_PROXY = loopback/本地
buildProxyDispatcher(proxy): Dispatcher | undefined // (b) undici ProxyAgent（含 Basic Auth）；给 ② 的 fetch
```

`enabled=false` 时全部产出为「空/直连」，调用点无需各自判断开关。

### 4. 各出口注入点

**① pr-agent LLM（低成本，首要）**
在 [ipc.ts](../../apps/desktop/src/main/ipc.ts) 组 `env` 处（`buildPragentEnv` 之后）合并 `buildProxyEnv(proxy)`。litellm 底层 httpx 默认 `trust_env=True`，认 `HTTPS_PROXY` + `NO_PROXY`（带 Basic Auth 的 `http://user:pass@host:port` 也支持）→ **零侵入 python**。LLM 域名不在绕过名单 → 自动经代理。

**② Bitbucket Server REST（中成本）**
[BBClientOptions](../../packages/platform-bitbucket-server/src/client.ts) 增加可选 `dispatcher?`，`fetch` 调用带 `{ dispatcher }`；dispatcher 由 `buildProxyDispatcher` 给（开关开 + 目标非 loopback → ProxyAgent）。构造在 [adapters.ts](../../apps/desktop/src/main/adapters.ts) / [adapter.ts](../../packages/platform-bitbucket-server/src/adapter.ts)。
- 开关打开后 Bitbucket Server REST **经代理**；仅当目标是 loopback/本地时直连。
- 不采用 `setGlobalDispatcher` 全局兜底：会跳过 loopback 判断、且影响进程内所有 fetch；坚持**按出口**构造 dispatcher。

**③ git clone/fetch（HTTPS，低成本）**
`simple-git` 实例传 env：`.env({ ...process.env, ...buildProxyEnv(proxy) })`（注意 simple-git 的 `.env()` 整体替换，必须 merge `process.env`）。git 认 `http.proxy`/`https_proxy`，开关打开后 clone/fetch（Bitbucket Server HTTPS）**经代理**（loopback 由 `NO_PROXY` 排除）。改在 [repo-mirror-manager.ts](../../packages/repo-mirror/src/repo-mirror-manager.ts)（需把 proxy 经构造参数传进去）。

**④ git clone/fetch（SSH）— 不在代码接管，引导用户自配**
SSH 走系统 ssh、HTTP 代理不直接适用（须 `ProxyCommand`），且跨平台无统一方案（macOS/Linux 有 `nc -X`，**Windows 无 `nc`**）。本期**不在代码里接管 SSH 代理**：
- SSH clone 默认走系统 ssh，本就读 `~/.ssh/config`；
- 文档化引导 SSH 用户在 `~/.ssh/config` 给 Bitbucket Server host 配 `ProxyCommand`（零代码、用户完全可控、跨平台各自按系统办）。

### 5. 设置页 UI
SettingsModal 增「网络代理」分区：开关 + 地址 + 端口 + 用户名 + 密码（Basic Auth，可空）+ **「测试连通」**（用配置经代理对一个样例外网地址试连，给明确成败反馈）。仅此五项，无其他旋钮。

### 6. 一期范围

| 出口 | 一期 |
| --- | --- |
| ① pr-agent LLM | ✅ 做（首要，经代理） |
| ② Bitbucket Server REST | ✅ 做（经代理；loopback/本地直连） |
| ③ git HTTPS | ✅ 做（经代理；loopback/本地直连） |
| ④ git SSH | ⏸ 仅文档引导 `~/.ssh/config`，代码不接管 |

## 后果

### 正面
- 内网用户可让 pr-agent 出网调 LLM —— 解除阻断。
- 单一全局代理：LLM、Bitbucket Server、git HTTPS 统一走代理，行为一致；仅 loopback/本地自动直连。
- 配置面极简（地址/端口/Basic Auth），用户**只填一个代理地址**、不必理解 `no_proxy`。
- ① 零侵入 python（纯 env），③ 复用 git 原生能力，成本集中在 ② 的 dispatcher。

### 负面
- **一期只支持 HTTP 代理**：socks5 收益不大、**本期不实现**；`protocol` 枚举已留扩展位，将来若确有需要再加（不改配置结构）。
- **SSH 代理不接管**：退化为文档引导用户自配 `~/.ssh/config`。
- **代理密码明文落盘**：`password` 与现有 config.yaml 明文策略一致（见 [config-store](../../packages/config/src/config-store.ts)），不额外加密；文档提示风险。

### 后续可能升级
- socks5 支持（收益有限，按需；`protocol` 枚举追加 `'socks5'` + 对应 dispatcher）。
- SSH 代理程序化接管（按平台分支）。
- 读系统代理 / `HTTP_PROXY` env 作默认值。

## 落地清单（建议顺序）

1. [x] `ProxySchema`（enabled/protocol/host/port/username/password）进 [ConfigSchema](../../packages/shared/src/config.ts) + 默认值（全 `.default`，老配置自动兼容）。
2. [x] [`apps/desktop/src/main/utils/proxy.ts`](../../apps/desktop/src/main/utils/proxy.ts)：`proxyUrl` / `shouldBypass`（loopback/本地） / `buildProxyEnv` / `buildProxyDispatcher` / `proxyFetchForHost` / `testProxyConnectivity`。
3. [x] **① pr-agent**：[ipc.ts](../../apps/desktop/src/main/ipc.ts) 组 env 处合并 `buildProxyEnv(config.proxy)`。
4. [x] **③ git HTTPS**：[repo-mirror-manager](../../packages/repo-mirror/src/repo-mirror-manager.ts) 加 `proxyEnv` getter，clone/fetch `.env({ ...process.env, ...proxyEnv })`。
5. [x] **② Bitbucket Server REST**：经 [adapters.ts](../../apps/desktop/src/main/adapters.ts) 的 `fetch` 注入口挂 `proxyFetchForHost`（零改动平台包）；新增 IPC `config:setProxy`（热重建 adapter）/ `config:testProxy`。
6. [x] 设置页「网络代理」分区（开关/地址/端口/用户名/密码）+ 「测试连通」（[SettingsModal](../../apps/desktop/src/renderer/src/components/SettingsModal.tsx)）。
7. [x] 文档：[README](../../README.md) 网络代理段 + 本 ADR 链接；**④ SSH 用户 `~/.ssh/config` ProxyCommand 指引**。
8. [ ] 验证矩阵（待真实代理端到端）：LLM 经代理可调 / Bitbucket Server REST 经代理 / git HTTPS 经代理 / 本地(loopback/Ollama)直连 / Basic Auth 生效 / 关闭开关回到现状。（CI lint/typecheck/test/build 已全绿）
