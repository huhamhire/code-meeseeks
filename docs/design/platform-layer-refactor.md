# 平台连接层抽象重构设计（草案）

> **状态**：已落地（归档）。对应里程碑 [#6 平台连接层抽象重构统一](https://github.com/huhamhire/code-meeseeks/milestone/6)。
> 设计已实现并沉淀为当前结论，见 [01 · 代码平台适配](../arch/01-platform-adapter.md)；本文作为设计过程记录归档保留。
>
> 本文是**重构提案**（面向「应当变成怎样」），区别于 `docs/arch/` 的**当前结论**。

## 1. 背景与问题

平台连接层把 GitHub / Bitbucket Server / GitLab 的差异收口到统一抽象，业务层（轮询、镜像、评审发布）
只依赖该抽象。当前实现已覆盖三个平台并稳定运行，但抽象形态在持续扩张后暴露出三类结构性问题。

### 1.1 单一巨接口职责混杂

`PlatformAdapter` 是一个约 20 个方法的单接口，横跨连接探测、PR 发现、评论读写、审批、合并、克隆、
头像 / 附件等多个互不相关的功能领域。后果：

- **新增平台门槛高**：实现方必须一次性补齐全部方法，无法按领域分步落地。
- **测试负担重**：任何只用到其中一两个方法的消费方（如轮询器只需「发现 + 能力」），其测试桩仍要
  实现整套接口——`FakeAdapter` 为满足契约补了大量空桩。
- **演进牵一发动全身**：领域 A 的方法签名调整会波及所有实现与所有桩。

### 1.2 跨平台样板重复

三个平台各自实现一套 REST 客户端，结构高度同构：超时 + `AbortController`、错误解析与抛出、
`get/getWithHeaders/post/put/del`、分页异步迭代器、二进制拉取与可信域校验。三份客户端合计约 800 行，
差异其实只集中在四处：

| 差异点 | GitHub | Bitbucket | GitLab |
| --- | --- | --- | --- |
| 鉴权头 | `Authorization: Bearer` | `Authorization: Bearer` | `PRIVATE-TOKEN` |
| 分页风格 | `Link` 头 next | `start/limit` + `isLastPage` | `Link` 头 next |
| 错误类 | `GitHubClientError` | `BitbucketClientError` | `GitLabClientError` |
| 可信资产域 | api/web/githubusercontent | 同实例 host | 同实例 host + `/uploads` |

适配器内部的映射脚手架（`collect`、用户映射、base URL 归一与 host 推导等）也在三处各写一遍。

### 1.3 降级声明与方法分离

可降级能力集中声明在 `capabilities()` 返回的 `PlatformCapabilities` 里，与「被它约束的方法」相隔很远。
新增 / 调整一个可降级能力要改三处且无编译期约束串联：① `PlatformCapabilities` 类型；② 每个平台
`capabilities()` 的返回；③ 调用处的降级分支。三处任一漏改不会报错，只会在运行期表现为「能力位与实际
行为不符」。

---

## 2. 目标与非目标

### 目标（对应里程碑三项）

1. **抽取平台连接模版包**：归纳出基础模版包，但它**只声明业务契约**（领域接口 + 各领域抽象基类 + 传输端口
   + 可选 helper），**不含 HTTP 传输实现**；具体连接层适配由各平台包自负，消除跨包重复的同时不耦合传输细节。
2. **按功能领域拆分接口**：不再用单一巨接口；面向不同业务领域抽取独立 interface 与**独立抽象基类**（PR 操作 /
   评论 / 用户与媒体 / 连接），各领域可独立实例化、独立维护，再组装到总 client。
3. **可降级方法的声明式标记**：可降级的方法就近声明其降级能力，单一事实来源聚合出对外能力描述符，
   消除「改三处、易漏配」。

### 非目标

- **不改中性数据模型形状**：`PullRequest` / `PrComment` / `MergeStatus` 等对外类型保持不变。
- **不改对外 IPC 契约**：`ConnectionSummary.capabilities` 序列化形状（即 `PlatformCapabilities`）保持不变，
  渲染层零感知。
- **不改各平台 REST 端点逻辑与业务语义**：这是**重构而非重写**——端点、降级判据、归一逻辑原样搬运重组，
  以「行为等价」为铁律。
- **不引入运行时反射 / 装饰器元数据框架**：保持 TS strict 下的静态可分析性与 electron-vite 打包简单。

### 约束

- TypeScript strict；业务层维持「零 `if (platform === ...)`」（见 [01 §2](../arch/01-platform-adapter.md)）。
- 每阶段 `lint → typecheck → test → build` 全绿。
- 行为等价由**适配器契约测试套件**守护（[01 §5](../arch/01-platform-adapter.md) 已建议、本次落地为基线）。

---

## 3. 总体设计

三层切分。**core 是契约层、与 HTTP 解耦**；**连接 / 传输实现归各平台包自负**；根 client 只做组装：

```
@meebox/platform-core   契约层（只声明业务契约，零 HTTP 实现）
  ├ 领域接口 + 各领域抽象基类（BaseConnection / BasePullRequest / BaseComment / BaseMedia，
  │                            承载跨平台业务逻辑，依赖传输端口、不含传输实现）
  ├ 传输端口 PlatformTransport（接口：声明领域基类所需的最小连接能力）
  ├ 能力声明装置 + 组合器 composePlatformAdapter
  └ 可选传输 helper（自由函数：超时 / JSON / 错误解析等同构片段，平台按需组合，非强制）
        ▲ implements 传输端口 / extends 领域基类
        │
platform-github / -bitbucket-server / -gitlab   实现层（连接层自负）
  ├ 统一连接封装实例：实现 PlatformTransport，独自负责鉴权 / 分页 / 超时 / 可信域
  ├ 各领域服务：extends 对应领域基类，注入连接实例，补平台端点 + 映射
  └ 各领域能力声明块
        ▲ composePlatformAdapter(ctx, {...})
        │
PlatformAdapter（根 client）   领域服务容器：connection / prs / comments / media
```

### 3.1 Core 只声明业务契约，连接层归平台包自负

新增内部包 `@meebox/platform-core`，但它**不承载任何 HTTP 封装行为**，只做业务层面的契约声明。具体 API
连接 / 传输层的适配实现，由各平台包**自己负责**——避免在 core 里放一个「什么都管」的具体客户端基类，把传输
细节与业务契约耦合、又被迫用抽象钩子去兜平台分页 / 鉴权差异（典型的抽象泄漏）。

core 导出四类纯契约 / 装置：

- **领域接口 + 各领域抽象基类**（见 §3.2）：声明业务契约，并承载跨平台**业务逻辑**（评论树归一、提交
  newest-first 契约、能力聚合等），但**不含传输实现**。
- **传输端口 `PlatformTransport`（接口）**：声明领域基类发起调用所需的**最小连接能力**——如
  `request(method, path, body?)`、`paginate<T>(path, params?)`、`getBinary(url)`。这是 core 与平台传输
  实现之间的**唯一接缝**（port）；领域基类只依赖此端口，不知道底层是 fetch、用什么鉴权头、怎么翻页。
- **能力声明装置 + 组合器**：`CapabilityDecl` 类型、`capabilities()` 聚合、`composePlatformAdapter`。
- **（可选）传输 helper**：把超时 + `AbortController`、JSON / 二进制解码、错误体解析等**确属同构**的片段提取为
  **自由函数**（非基类），供平台传输实现**按需组合复用**。它是「可选工具」而非「强制基类」——用不用、怎么拼
  由平台自决，core 不替平台决定传输形态。

> **登记两步**（[AGENTS.md 工程坑](../../AGENTS.md)）：新内部包除 `npm install` 外，必须 ① 在
> `apps/desktop/package.json` 加 `"@meebox/platform-core": "*"`；② 在 `electron.vite.config.ts` 的
> `internalPackages` 数组登记，否则运行期 `.js`→`.ts` 解析崩。

#### 统一连接封装实例（每平台包自负，实现传输端口）

每个平台包把「平台 API 连接」收敛成一个**统一封装实例**——它**实现 `PlatformTransport` 端口**，是该平台连接 /
鉴权配置的**单一持有者与单一出口**，把以下共性配置一次封装、对领域服务屏蔽：

- **连接参数**：API base URL（含归一与 host 推导）、单请求超时。
- **鉴权配置**：PAT / token 与鉴权头构造（Bearer vs PRIVATE-TOKEN），token **只进此实例、绝不外泄进日志**。
- **出站通道**：可注入 `fetch`（挂代理 dispatcher / 测试桩，见 [09 网络与代理](../arch/09-networking-proxy.md)）。
- **可信资产域**：带凭据拉取的白名单（防 PAT 外发 / SSRF）。

§1.2 表中四处平台差异（鉴权头 / 分页 / 错误类 / 可信域）**全部落在平台包内的这个实例里**，不再上浮成 core 的
抽象钩子。平台可借 core 的可选 helper 削减样板，但**传输的所有权与责任始终在平台包**。效果：

- **连接层可独立演进**：换鉴权方式、调超时、接代理只改本平台封装实例，core 与其他平台零感知。
- **领域服务无状态化**：服务只编排端点与映射，连接态（token / cachedUser / 版本套餐）集中在封装实例 +
  共享上下文（见 §3.2），便于复用与测试替身（测试只需提供一个假的 `PlatformTransport`）。
- **core 零传输耦合**：core 不 import fetch、不知鉴权细节，只持端口与可选工具。

#### 代理配置统一进连接层

代理是连接配置的一部分，应**统一进连接层**，而非由各调用点临时拼。统一连接配置 `PlatformConnectionConfig`
携带 `proxy: ProxyConfig` 字段（与 `baseUrl` / `token` / `timeoutMs` 并列）；连接层在构造时据 `baseUrl`
host **一次性解析**有效 fetch——loopback / 本地直连、否则挂代理。这替代当前散落在三处适配器构造点各自调用
`proxyFetchForHost(proxy, host)` 再注入 fetch 的写法，使「一个连接 = 一份连接配置（含代理）= 一次解析」。

为保持 core 不依赖具体代理实现（undici `ProxyAgent`），解析经一个**注入的 `ProxyFetchFactory`**完成：
core 只声明 `(proxy, host) => fetch | undefined` 这一类型与 `resolveConnectionFetch` 解析顺序（显式 fetch
覆盖 > 代理解析 > 直连兜底），由组合根（desktop）提供 undici 实现（复用现有 `proxyFetchForHost`）。代理凭据
随 `ProxyConfig` 进连接层、绝不进日志。

### 3.2 每个领域一套独立基类，组装到根 client

把 20 个方法按业务领域归入四个领域（按里程碑示例的 PR 操作 / 评论 / 用户信息维度）；**每个领域有自己独立
可维护的抽象基类**（放 core），平台包为每个领域写一个子类 `extends` 对应基类。基类承载该领域**跨平台一致**的
业务逻辑，子类只补**平台特定**的端点与映射——一个领域的演进不牵动其他领域。

| 领域（接口 / 基类） | 方法 | 基类承载的跨平台逻辑（示例） |
| --- | --- | --- |
| **`PlatformConnection` / `BaseConnection`**（连接 / 身份 / 克隆，根服务） | `kind`、`capabilities()`、`ping()`、`getCurrentUser()`、`setCurrentUser?()`、`getCloneUrl()` | `cachedUser` 缓存读写、能力声明块聚合；子类补 ping 端点与 clone URL 构造 |
| **`PullRequestService` / `BasePullRequest`**（PR 操作） | `listPendingPullRequests()`、`listPullRequestCommits()`、`listPullRequestActivity()`、`setPullRequestReviewStatus()`、`mergePullRequest()` | 「commits 必须 newest-first」契约的统一收口（子类声明原始序、基类保证方向）；子类补发现 / 详情端点 |
| **`CommentService` / `BaseComment`**（评论） | `listPullRequestComments()`、`publishSummaryComment()`、`publishInlineComment()`、`replyToComment()`、`editComment()`、`deleteComment()` | 评论树归一（顶层 + 嵌套 reply 组装）、summary/inline 分类的统一结构；子类补各平台端点（GitHub 三分体系 / GitLab discussions / Bitbucket activities） |
| **`MediaService` / `BaseMedia`**（用户与媒体） | `getUserAvatar()`、`getAttachment()` | 「不可信 / 失败 → null 回退」的统一契约；子类补 URL 推导，经 `transport.getBinary` 拉取 |

各领域基类经构造注入的 `PlatformTransport`（§3.1 端口）发起调用，并共享一份连接态——见下文 `ConnectionContext`。

> 审批 / 合并（`setPullRequestReviewStatus` / `mergePullRequest`）归在 PR 操作下。若后续评审写路径继续膨胀，
> 可再裂出独立 `ReviewService` / `BaseReview`——领域基类本就为这种分步演进而设。

**组装到根 client**：`composePlatformAdapter(ctx, { connection, prs, comments, media })` 把四个领域服务
实例组装成根 `PlatformAdapter`（领域服务容器）。根即「总的 client」——它**不含业务逻辑**，只持有并暴露各领域：

```ts
interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly connection: PlatformConnection;
  readonly prs: PullRequestService;
  readonly comments: CommentService;
  readonly media: MediaService;
}
```

四个领域服务共享一份 **`ConnectionContext`**——它持有平台的**统一连接封装实例**（§3.1，即 `PlatformTransport`
实现）外加 `cachedUser`、探测到的版本 / 套餐等连接态，由组合器一次构造、注入全部领域基类，确保「一个平台连接
= 一个封装实例 = 一份连接态」，各领域不重复持有 transport 或 token。调用处从 `adapter.listPullRequestComments(...)`
变为 `adapter.comments.list(...)`——消费方按领域取所需服务，测试桩亦只需实现用到的领域。

> **方案取舍**：另一选项是「扁平」——`PlatformAdapter` 仍是一个接口、只在类型上把方法分组，实现仍为单类。
> 它对调用方零改动，但巨类仍在、未达成「独立实例化管理」与「领域独立基类」。里程碑明确要求「抽取单独
> interface 做实例化管理」，故选**组合**：调用面改动可控（消费方约 6 处，均内部代码），换来真正的领域内聚、
> 可分步测试与各领域基类独立演进。

### 3.3 可降级方法的声明式标记

保留 `PlatformCapabilities` 作为**对外序列化契约**（IPC `ConnectionSummary.capabilities` 形状不变），
但改变其**来源**：从「每平台手写整个返回对象」改为「各领域服务就近声明 + 根聚合」。

每个领域服务导出一个**能力声明块**，与被约束的方法并置：

```ts
// CommentService 实现内，与方法并置
static readonly capabilities = {
  inlineComments:        { value: true,  governs: 'publishInlineComment' },
  inlineMultiline:       { value: true,  governs: 'publishInlineComment', degrade: 'disable' },
  commentOptimisticLock: { value: false, governs: ['editComment', 'deleteComment'] },
  commentHardBreaks:     { value: true },
  resolvableThreads:     { value: false, degrade: 'hide' },
  suggestions:           { value: false, degrade: 'hide' },
} satisfies CapabilityDecl<CommentCapabilityKey>;
```

- **`value`**：能力取值（布尔 / 枚举 / 数组，覆盖 `reviewStatuses`、`mergeVetoFidelity`、`discoveryFilters`
  等异构字段）。
- **`governs`**：声明该能力位约束哪个 / 哪些方法，把「能力位」与「方法」在类型与代码位置上绑定——
  漏配即类型不完整、就近可见。
- **`degrade`**：`'hide' | 'disable' | 'fallback'`，对齐 [01 §2 的降级三态](../arch/01-platform-adapter.md)；
  可带 `reason`（错误码 `E...`，供置灰 tooltip，对齐 [12 错误码](../arch/12-error-codes.md)）。

根服务的 `capabilities()` 把各领域声明块**聚合**成扁平 `PlatformCapabilities`（连接探测后按版本 / 套餐
细化，如 GitLab CE/EE 的 `reviewStatuses`）。新增 / 调整能力只改**声明块一处**，对外形状与聚合逻辑不动。

「平台概念上根本没有」的方法（如 GitLab CE 无审批、未实现的线程解决）以 `value:false` + `degrade:'hide'`
声明，替代当前「返回 `[]` / 抛错」的隐式表达。两层能力来源（静态 vs 动态 PR 数据）维持 [01 §2](../arch/01-platform-adapter.md)
不变——本次只改静态层的**声明方式**，不动动态层。

#### 对外形状为何「内部分组 + 外部扁平」

内部按领域就近声明、对外仍是扁平 `PlatformCapabilities`，这是**有意取舍**而非漏改：

- 渲染层是**叶子消费者**——逐个 feature 读 flag 决定显 / 隐 / 灰，不需要领域分组；扁平读起来更顺手。
- 内外不对称只是聚合器在 IPC 边界做一次 flatten，属序列化边界的常规动作。
- 把 wire shape 也改成分组（`{ comment:{…}, review:{…} }`）会连带改渲染层 + IPC 契约 + i18n，功能收益接近零。

因此**维持扁平 wire 契约**；若需分组的人体工程学，在**渲染层**派生 typed selector（`commentCaps` / `reviewCaps`），
不碰 IPC。仅当未来出现「按领域整组门控能力」的真实需求时，才考虑把对外形状也改为分组。

---

## 4. 契约影响与迁移

### 消费方迁移点

| 消费方 | 现状 | 迁移后 |
| --- | --- | --- |
| `adapters.ts` 工厂 | `new XxxAdapter(...)` 返回巨类 | `composePlatformAdapter(ctx, {...})` 组装根 |
| 轮询器 `poller` | `adapter.listPendingPullRequests` / `capabilities().discoveryFilters` | `adapter.prs.listPending` / `adapter.connection.capabilities()` |
| 评论服务 | `adapter.capabilities().commentOptimisticLock` | `adapter.connection.capabilities()`（聚合自 CommentService 声明） |
| app 服务 | `adapter.capabilities()` → `ConnectionSummary` | `adapter.connection.capabilities()`（形状不变） |
| `pr-service` | `adapterForOrThrow(pr)` 返回根 | 不变（返回根，调用处取子领域） |
| repo-mirror | `adapter.getCloneUrl(repo)` | `adapter.connection.getCloneUrl(repo)` |

对外 IPC（`ConnectionSummary.capabilities`）形状不变 → **渲染层零改动**。

### 分阶段落地（每阶段独立可合、四步全绿、行为等价）

- **Phase 0 · 传输端口与连接收口**：建 `@meebox/platform-core`，先落 `PlatformTransport` 端口 + 可选 helper；
  三平台把各自 client 收敛为「实现端口的统一连接封装实例」，可借 helper 削减样板。**不动接口形状**，纯内部
  重组，契约测试不变即验证等价。
- **Phase 1 · 领域拆分**：在 `platform-core` 定义四个领域接口与抽象基类；`PlatformAdapter` 改为领域容器；
  各平台为每个领域写子类 `extends` 基类、注入 transport，经 `composePlatformAdapter` 组装；迁移上表消费方。
- **Phase 2 · 声明式能力**：各领域服务落能力声明块，`capabilities()` 改为聚合；删除集中式手写返回。
- **Phase 3 · 收尾**：更新 [arch/01](../arch/01-platform-adapter.md) 为新结论；契约测试套件按领域重组，
  补 `fakeAdapter(partial)` 测试 helper（只需实现所测领域）。

内部包无对外 API 兼容包袱，Phase 1 可在单个版本内整体切换，无需长期并存的兼容垫片。

---

## 5. 风险与取舍

- **抽象泄漏（已由设计规避）**：不再用「统一具体客户端基类 + 抽象钩子兜差异」；传输实现归平台包，core 只持
  端口 + 可选 helper，平台特性不上浮到 core。
- **HTTP 去重弱化（取舍）**：传输归平台自负后，HTTP 样板的去重从「强制继承」降为「可选组合」（平台可不用
  helper、自写传输）。对策：把同构片段做成好用的自由函数 helper，靠 code review 与契约测试守一致，不强求
  零重复——换 core 零传输耦合、连接层可独立演进，判断收益更高。
- **调用面改动**：组合方案使消费方调用路径变化（约 6 处内部文件）。对策：改动集中、可机械迁移，且换来
  领域内聚与可分步测试，收益大于一次性成本。
- **不用装饰器**：声明式能力用**静态声明对象 + `satisfies` 类型约束**实现，不引入 decorator / 反射元数据，
  规避 electron-vite 打包与 strict 下的运行期复杂度。
- **能力聚合正确性**：聚合逻辑成为单点，需契约测试覆盖「各平台聚合后的 `PlatformCapabilities` 与重构前
  逐字段一致」，作为 Phase 2 的等价闸门。

---

## 6. 验收标准

- **行为等价**：适配器契约测试套件全过；三平台聚合出的 `PlatformCapabilities` 与重构前逐字段一致。
- **去重见效**：三平台 client 共性下沉，新增一个可降级能力只改声明块一处。
- **接缝守住**：业务层仍零 `if (platform === ...)`；新增平台可按领域分步实现。
- **测试减负**：测试桩可只实现所测领域（`fakeAdapter(partial)`）。
- **四步全绿**：`lint → typecheck → test → build`，每阶段均通过。
</content>
</invoke>
