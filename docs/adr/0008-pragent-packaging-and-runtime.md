# ADR-0008: pr-agent 打包与运行时策略（嵌入式 Python + Docker 可选）

- **状态**：Accepted
- **日期**：2026-06-04
- **决策者**：项目主导
- **相关**：[ADR-0001](./0001-pr-agent-integration.md)（被本 ADR 扩展 / 部分取代）、[ROADMAP §M5](../ROADMAP.md#m5--打磨与多平台扩展持续)

## 背景

ADR-0001 定的集成方式是「LocalCli 为主 + Docker fallback」，核心优点是"升级 pr-agent = 改一个 tag / `pip install -U`，对主体零影响"。但它把**运行时依赖甩给了用户**：

- LocalCli 模式要求用户自己 `pipx install pr-agent` 并管理 Python 环境；
- Docker 模式要求用户装并启动 Docker Desktop（Windows 还连带 WSL2）。

对"面向 Reviewer **个人**的本地化 GUI 客户端"这个定位，两条路都是真实的分发摩擦：目标用户里相当一部分不愿意 / 不会装 Python 或 Docker。M5「降低部署门槛」要求**双击即用、零外部运行时依赖**。

同时，ADR-0007 诊断、以及后续 `get_line_link` anchor 根因分析（见 ROADMAP M5「`/review` finding anchor 根因修复」）都指向一个需求：**我们需要稳定地、无侵入地改 pr-agent 自身的行为**（注入行链接、捕获 litellm token、裁剪预处理、乃至 daemon 化）。当前 Docker 模式下只能靠 `-v` 挂 shim + 每次 `-e PYTHONPATH`，笨重且易漏。

约束：

- 初版发布**只适配 Windows x64 + macOS arm64**（覆盖团队主力机型；Linux / mac x64 / win arm64 推后）。
- 不引入对用户机器 Python / Docker 的**强制**依赖。
- 升级 pr-agent 仍应尽量低成本，且**不 fork 上游源码**。
- 必须能无侵入地 monkeypatch pr-agent 行为，且补丁与上游解耦。

## 决策驱动因素

1. **分发门槛**：开箱即用，不要求用户预装运行时。
2. **可维护性**：跟上游版本的成本；不产生需要长期 rebase 的 fork。
3. **可改造性**：能否稳定地注入自定义行为（行链接 / token / 预处理 / daemon）。
4. **构建复杂度 / 制品体积**：CI 矩阵、平台签名、安装包大小。
5. **跨平台一致性**：行为由我们的构建决定，而非用户环境。

## 候选方案

### A. 嵌入式 Python 解释器 + 隔离环境内依赖安装（**采用**）

随 app 资源附带一份**可重定位 CPython**（[python-build-standalone](https://github.com/astral-sh/python-build-standalone)），构建期把 pinned 版本的 pr-agent 及其依赖 `pip install` 进这份分发的隔离 site-packages（不污染、也不依赖用户系统 Python）。主进程 spawn `<bundled-python> -m pr_agent.cli ...`，沿用 local provider（cwd = worktree）。

- ✅ 零用户运行时依赖，双击即用
- ✅ litellm 的**动态 provider import 天然可用**（是真实 site-packages，不是被静态冻结的依赖图）
- ✅ 版本完全可复现（制品即版本，不受用户 pip / 镜像 registry 漂移影响）
- ✅ 比 Docker 冷启动快：省掉容器创建 + volume mount（ADR-0001 / overhead 笔记的 A 段）
- ✅ **monkeypatch 一等公民**：`sitecustomize.py` shim 直接放进 bundled site-packages，永久就位，无需挂载 / 传参
- ✅ 不 fork：上游以 pinned 版本安装，补丁全在我们自己的 shim 文件里
- ❌ 安装包按平台变大（含解释器 + litellm/langchain 等重依赖，约 150–400MB/平台）
- ❌ 按平台构建；macOS 上 bundled 解释器 + .dylib/.so 需签名 + 应用公证
- ❌ 升级 pr-agent 从"改 tag"变成"构建期重装 + 跑 smoke test"（仍远轻于冻结方案）

### B. PyInstaller / Nuitka 冻结成单二进制（用户初始设想，**否决**）

把 pr-agent 冻结成独立可执行文件内嵌。

- ✅ 概念上最"单文件"
- ❌ **冻结工具与 pr-agent 依赖栈严重不友好**：litellm 运行时动态 import provider 模块（静态分析扫不到，要手工 `--collect-all` + hidden-imports，漏一个就运行时崩）；tiktoken 编码数据、tree-sitter 语法、pr-agent 自带 settings TOML 都是 data files 要显式打包
- ❌ 每次 pr-agent 升级都可能打破冻结配置 → 维护税最高，恰好丢掉 ADR-0001 最看重的低升级成本
- ❌ 相比 A 没有实质收益（体积接近、依赖一样重），只是把"装好的 venv"换成"难调的冻结产物"

### C. git submodule + 源码构建（**否决**）

把 pr-agent 作为 submodule 拉进工程，从源码构建。

- ❌ submodule 真正的价值是"携带源码补丁"，但本 ADR 选择 monkeypatch 路线、**上游保持原封**，submodule 带来的 fork/rebase 负担没有对应收益
- ❌ 仍要在构建期解析 pr-agent 的依赖树，不比 A 简单
- ❌ 用户明确要求不使用 submodule

### D. 维持现状（仅 LocalCli + Docker，**否决作为默认**）

- ✅ 零新增构建复杂度
- ❌ 不解决分发门槛——与 M5 目标冲突
- 但其 Docker 能力作为**可选回退保留**（见决策）

## 决策

**初版发布采用方案 A（嵌入式 Python 解释器 + 隔离环境内依赖安装）作为主流默认方案，并保留 Docker 模式作为可经配置文件启用的回退。**

### 1. 新增第三种 PrAgentBridge 策略

扩展 `PrAgentStrategy`：

```ts
export type PrAgentStrategy = 'embedded' | 'local-cli' | 'docker';
```

新增 `EmbeddedRuntimeBridge`，与现有 `LocalCliBridge` 形态几乎一致（local provider，cwd = worktree，`CONFIG__GIT_PROVIDER=local`），区别仅在于 `cmd` 指向 **bundled 解释器绝对路径**而非 PATH 上的 `pr-agent`：

```
<resources>/pragent/python/bin/python   (mac)
<resources>\pragent\python\python.exe   (win)
  -m pr_agent.cli --pr_url <targetBranch> <tool> [extra...]
```

`LocalCliBridge` / `DockerBridge` 原样保留，零分叉。

### 2. 制品布局（随 app 打包）

```
<app resources>/pragent/
├── python/                 # python-build-standalone 可重定位发行版
│   └── .../site-packages/  # 构建期 pip install pr-agent==<pinned> + 依赖
│       └── sitecustomize.py  # 我们的 monkeypatch shim（永久就位，见 §4）
└── VERSION                 # 记录内嵌的 pr-agent 版本，运行时探测/展示用
```

- pr-agent 版本沿用 `DEFAULT_DOCKER_IMAGE_TAG` 同源的 pinned 常量（构建期 pip 安装的就是它），升级走 PR + smoke test。
- shim 直接落在 bundled site-packages，`site` 启动时自动 `import sitecustomize`，无需 `-e PYTHONPATH` / `-v` 挂载。

### 3. 策略选择与 Docker 回退开关

config 新增 `pr_agent` 块（缺省即默认行为，老配置无感）：

```yaml
pr_agent:
  strategy: auto          # auto | embedded | docker | local-cli
  docker_image: pragent/pr-agent:0.36.0   # 仅 docker 模式用
```

- `auto`（默认）：优先 `embedded`（制品内必带，正常安装恒可用）；制品缺失（如源码 dev 运行）时回退探测 `local-cli` → `docker`。
- 用户想用 Docker（如想换镜像 / 在已有 Docker 基建上跑）→ 改 `strategy: docker`，能力**完整保留**。
- 探测结果 / 当前策略在状态栏 / 设置页可见（`PrAgentStatus` 已有 strategy 字段）。

### 4. monkeypatch 治理（无侵入改 pr-agent 行为）

所有对 pr-agent 行为的改造走 **bundled site-packages 里的 `sitecustomize.py` shim**，上游源码保持 pristine：

- 首批目标：`LocalGitProvider.get_line_link` 注入结构化 anchor（ROADMAP M5 该条直接受益，且不再需要 Docker 的挂载 gymnastics）。
- 后续可加：litellm 成功回调捕获 prompt+completion tokens（解 M3 推迟项）、D 段预处理裁剪、乃至 daemon 化 wrapper。

**护栏（强制）**：

1. 每个 patch 用 `try/except` 包裹，打不上则静默降级，绝不让 shim 异常阻断 pr-agent 主流程。
2. CI 增加 **smoke test**：用 bundled 运行时跑一次 `/review` fixture，断言被 patch 的行为确实生效（如 anchor 出现）。pr-agent 升级若打破 shim，CI **响**而非用户线上才发现。

### 5. 初版平台范围

- **Windows x64**、**macOS arm64** 出包；其余（Linux / macOS x64 / Windows arm64）推后，按用户实际需求排期。
- macOS arm64：bundled 解释器及全部 `.dylib/.so` 需 codesign + 应用整体公证（hardened runtime），否则 Gatekeeper 拦截被 spawn 的子进程。
- 在不支持的平台 / 缺制品时，`auto` 回退到 `local-cli` / `docker`，并在设置页给安装指引——保证开发者与未覆盖平台仍可用。

## 后果

### 正面

- 主流用户**零运行时依赖、开箱即用**，契合本地 GUI 定位与 M5 门槛目标。
- 版本完全可复现，行为由我们的构建掌控，跨机一致。
- 冷启动快于 Docker（省 A 段）。
- monkeypatch 成为一等能力：shim 永久就位、上游不 fork、升级无 merge 冲突——解锁 anchor / token / 预处理裁剪 / daemon 化一系列优化。
- Docker 能力保留，高级用户与特殊基建不被剥夺。

### 负面

- 安装包按平台显著变大（约 150–400MB/平台）。
- CI 矩阵新增：按平台构建 bundled 运行时 + 构建期 pip 安装 + macOS 签名/公证。
- 我们接管**构建期的 pr-agent 依赖解析**（上游 bump litellm 等时由我们兜）。
- 升级从"改 tag"变为"重装 bundle + 跑 smoke test"（仍远轻于冻结方案 B）。
- monkeypatch 耦合 pr-agent 内部符号，上游重构可能打破——由 §4 两条护栏兜底。

### 后续可能升级

- daemon 化（overhead 笔记方案 6）在自带运行时下从"高风险挂载方案"变为"附带一个常驻 wrapper"，可显著砍掉每 run 的 Python import 开销（B 段）。
- 平台扩展（Linux / mac x64）按需补构建目标。
- 若内嵌体积成为主要抱怨点，再评估 Nuitka/PyInstaller（方案 B）作为**额外**产物，而非替换 A。

## 落地清单（M5）

- [ ] `PrAgentStrategy` 加 `embedded`；`EmbeddedRuntimeBridge` 实现 + 探测接入 `auto`
- [ ] config `pr_agent.{strategy, docker_image}` schema + 设置页展示
- [ ] 构建管线：拉 python-build-standalone（win-x64 / mac-arm64）→ 构建期 pip install pinned pr-agent → 注入 `sitecustomize.py` → 并入 electron-builder 制品（衔接 M0 残项的打包矩阵）
- [ ] macOS：bundled 解释器 + 动态库 codesign + 公证流程
- [ ] `sitecustomize.py` 首发 shim：`get_line_link` 注入 + try/except 护栏
- [ ] CI smoke test：bundled 运行时跑 `/review` fixture，断言 anchor 生效
