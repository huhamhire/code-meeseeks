# AGENTS.md

面向自动化编码 agent 的工程维护速览。背景/业务见 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/arch/](docs/arch/README.md)。

## 仓库结构

Electron 桌面应用（npm workspaces + Nx 单仓多包）外加一个独立 Go CLI 子工程。关键路径（`apps/desktop` 是主战场）：

```
apps/desktop/              # Electron 应用（唯一有 build/dist 的项目）
├── src/
│   ├── main/              # 主进程：业务与 IO 唯一所在（启动/单例锁 · IPC handlers · 平台适配 · 服务层：pr · agent 编排 · 本地 API）
│   ├── preload/           # contextBridge 暴露泛型 invoke()
│   └── renderer/src/      # React 渲染层（UI / 交互）
├── scripts/               # 嵌入式 pr-agent 运行时组装 + monkeypatch shim
├── build-resources/       # electron-builder 打包资源（签名钩子 · entitlements）
└── vendor/pragent/        # 嵌入式运行时（gitignored，prepare:pragent 生成）

packages/<name>/           # 内部库 @meebox/*（各 src/index.ts 为入口）；shared 含共享类型 + IPC 契约
cli/                       # 独立 Go module：跨平台 CLI meebox（命令树 + HTTP client；经本地 API 集成，不入 npm/Nx）
```

- `apps/desktop` —— Electron 应用（main + preload + renderer/React）。唯一有 `build`/`dist` 的项目。
- `packages/*` —— 内部库（`@meebox/*`），按职责拆分；其中 `shared` 含共享类型与 IPC 契约。
- `cli/` —— 独立分发的 Go 命令行工具 `meebox`（外部集成用，不属 npm/Nx；详见下「CLI 工程（cli/）」段）。
- `docs/arch/` 各模块设计文档（首选入口）；`docs/guide/` 使用说明；`docs/ROADMAP.md` 路线图；`tools/` 杂项脚本。

**命名约定**：代码内部统一用中性代号 `meebox`（npm 作用域 `@meebox/*`）；对外品牌名 `Code Meeseeks`；用户数据目录 `~/.code-meeseeks/`。`pr-agent` 为第三方依赖，不在重命名范围内。

## 常用命令

根目录脚本（底层都是 `nx run-many`）：

```bash
npm run lint        # eslint，--max-warnings=0（warning 也算失败）
npm run typecheck   # tsc --noEmit
npm run test        # vitest（仅 packages 里带 test target 的，desktop/shared 无测试）
npm run build       # 构建（实际只 @meebox/desktop 有 build）
npm run format      # prettier 写入
```

单项目：`npx nx <target> <project>`，如 `npx nx test poller`、`npx nx typecheck desktop`。

桌面应用（在 `apps/desktop`）：

```bash
npm --prefix apps/desktop run prepare:pragent   # 组装嵌入式 Python + pr-agent 运行时（首次必跑）
npm --prefix apps/desktop run dev               # electron-vite dev
npm --prefix apps/desktop run dist              # 出安装包（见 docs/development/mac-build.md）
```

环境：Node ≥ 20（实测 22）、npm ≥ 10。**包管理器统一用 npm**（workspaces，lockfile `package-lock.json`）——勿用 yarn / pnpm。

## 依赖同步

**每次拉取代码后、以及发布前**，在仓库根目录执行一次完整安装并对齐运行时：

```bash
npm install                                      # 完整安装依赖、对齐 package-lock.json（workspaces 软链）
npm --prefix apps/desktop run prepare:pragent    # 对齐嵌入式 pr-agent 运行时与 shim（见 docs/arch/02-agent/03-pragent-runtime）
```

`npm install`（非 `npm ci`）会按 `package.json` 解析并写回 lockfile，确保本地与远端 `package-lock.json` 一致；`prepare:pragent` 幂等，按 `pragent-runtime.json` 对齐本地 pr-agent 运行时（版本不变则跳过、仅同步 shim）。lockfile 若被改动，按本次改动归属一并提交。

## 提交前必做

改完代码务必本地跑通这四步再收尾（CI 就是这套）：`lint` → `typecheck` → `test` → `build`。lint 零容忍（`--max-warnings=0`），warning 也会让 CI 红。

## 发布流程

发版：`dev` 汇入 `master` → 在 `master` 打 `v*` tag 触发 [release.yml](.github/workflows/release.yml)（出 Windows / macOS 安装包 + CLI 二进制 + GitHub Release）。

⚠️ **打 tag 前必须在同一批改动里完成三步前置（版本号 / CHANGELOG / 校对），随发版一并经 `dev` → `master`**——漏任一步 CI 不报错（仅 `::warning::`）但会产出错误的 Release。**完整前置清单、`-dev` 版本号规则、CHANGELOG 撰写风格见 [打包与发布](docs/development/packaging-release.md)**。tag 名须等于 package.json 版本（`v<版本>`）；名含 `-` 的预发布 tag 自动标 prerelease、不抢占 Latest。

## CLI 工程（cli/）

`cli/` 是独立分发的跨平台命令行客户端 `meebox`（供外部 agent / 脚本经[本地 API 服务](docs/arch/04-integration/01-service-api.md)集成）。设计见 [docs/arch/04-integration/02-cli.md](docs/arch/04-integration/02-cli.md)，用法见 [docs/guide/06-cli.md](docs/guide/06-cli.md)。

- **独立 Go module，不入 npm/Nx**：自带 `cli/go.mod`（纯 Go、无 CGO），非 workspace 成员、不进 Nx——根 `lint/typecheck/test/build` 不覆盖它，CLI 自成一套。
- **本地命令**（在 `cli/`）：`go vet ./...` → `go test ./...` → `go build ./...`，改完 CLI 三步过了再收尾。`go.sum` 入库（锁校验和）；构建产物（`bin/` / `meebox` 等）已 gitignore（见 `cli/.gitignore`）。
- **CI 分两条**：PR 门禁 [ci-cli.yml](.github/workflows/ci-cli.yml)（路径过滤 `cli/**`，跑 vet/test/build，与 Node 的 ci.yml 分开）；发布产出在 [release.yml](.github/workflows/release.yml) 的 `cli` job（`v*` tag 触发，交叉编译 Windows / macOS / Linux×2，出压缩包挂同一 Release；Windows / macOS 用 `.zip`、Linux 用 `.tar.gz`）。版本**取自 `apps/desktop/package.json`（与 app 同源，即 app 运行期版本的唯一真相源）**经 `-ldflags -X …/cmd.version` 注入——不独立依赖 git tag（发布前置已校验 tag == 该版本）。
- **压缩包即 skill 目录**：CLI 压缩包除二进制外一并打包 `LICENSE` + `cli/README.md` + `cli/SKILL.md`（frontmatter `name: meebox`）——解压投放到 agent 的 skills 目录即得可用 skill（面向 agent 交付的主形态）。
- **写边界**：CLI 做浏览 + **评审写动作**——approve / needswork（远端评审决断）与 comment（发评论），经服务端专用端点（复用 GUI 同源 controller）。仍**不开放**：merge（合并）与 pr-agent 变更类工具（publish 等，`instruct` 只读白名单 describe/review/ask/improve 在 CLI 与服务端双重把关）。新增命令先确认对应 API 端点已存在；放开新写端点须评估远端副作用。CLI 不得绕过 API 直连应用内部。
- **契约同步**：CLI 与服务端唯一耦合是 HTTP/JSON 线协议。当前手写 Go 结构对齐契约，契约增长后转 OpenAPI / Schema 代码生成。默认输出 YAML（人类向、保序）、`--output json` 供机器（亦保序）；PR 列表返回精简投影、PR 标识对外为 `id`、PR 关联命令用 `--pr <id>`。连接配置走 flag / 环境变量（`MEEBOX_API_URL` / `MEEBOX_TOKEN`）/ `~/.code-meeseeks/cli.yaml`，**不读 GUI 的 `config.yaml`**（避免越权触达连接层机密）；代理遵循标准 `HTTP(S)_PROXY` / `NO_PROXY`。
- **领域归类**：CLI / API / GUI 都是同一 service 层之上的薄前端，命令树与端点应**镜像业务领域**。新增 CLI 命令 / API 端点按语义归位——PR 相关入 `pr`、评审 Agent 入 `agent`；与具体 PR / Agent 无关的**系统性 / 会话级**操作（whoami / version 等）置于**根层级**，不套领域组。归属看**语义而非是否 PR 维度**（如 `categories` / `refresh` 无 `--pr` 仍属 `pr`——它们服务于 PR 列表）。完整理由见 [CLI 设计](docs/arch/04-integration/02-cli.md)。
- **文档对齐**：CLI 改动（命令树 / 写边界 / 输出契约 / 连接配置）须同步三类文档，缺一即漂移——① **arch 设计**：[docs/arch/04-integration/02-cli.md](docs/arch/04-integration/02-cli.md)（命令树与边界），涉及 API 端点再改 [01-service-api.md](docs/arch/04-integration/01-service-api.md)（端点表）；② **guide 用法**：[docs/guide/06-cli.md](docs/guide/06-cli.md)（英文正本 + 中文 [zh-CN/06-cli.md](docs/guide/zh-CN/06-cli.md) 两语同步）；③ **skill 交付**：`cli/SKILL.md` + `cli/README.md`（随压缩包投放为 agent skill 的主形态）。新增 / 改命令务必三类齐更。

## 约定

- **TypeScript strict**；React 19 + electron-vite + Monaco。优先复用现有工具/类型，匹配周边代码风格与注释密度。
- **包内异常用英语**：`packages/*`（内部库）里 `throw` 的错误信息一律用**英语**、**不做 i18n**（英语为默认/兜底语言，面向开发者排障）。**面向用户展示**的状态文案（如 Agent 的 terminationReason）才走 i18n 资源——二者区分清楚，别把用户文案塞进异常、也别给技术异常做翻译。
- **后台日志用英语**：`logger.*` / `console.*` 的日志信息一律用**英语**（开发者排障向、不面向用户、不做 i18n）。结构化字段值（路径 / id 等）原样；仅信息文本用英语。
- **面向用户的错误走错误码**：会跨 IPC 展示给用户的后端错误，统一封装 `AppError`（`code` + 可序列化 `meta`）、以错误码（`E`+两字母领域+四位数字，如 `EAG0001`）承载，本地化由**前端**按码做（i18n `errors.<CODE>`）；后端不拼面向用户的本地化字符串。技术异常 / 日志仍英语（与上两条不冲突——边界是「是否跨 IPC 展示给用户」）。规范见 [docs/arch/99-core/04-error-codes.md](docs/arch/99-core/04-error-codes.md)。
- **IPC**：main 用 `ipcMain.handle(channel, ...)`，renderer/preload 用泛型 `invoke<K>(channel, req)`，全部由 `packages/shared/src/ipc.ts` 的 `IpcChannels` 类型映射约束。新增通道先在那里加类型。
- **分支策略**：`master` 为发布分支，**禁止直接提交/修改**；所有特性与修复从 `dev` 拉分支开发，汇入 `dev` 验证后再合并到 `master`，发版在 `master` 打 `v*` tag 触发 release。
- **提交信息**：约定式提交、**中文**，带 scope，例：`feat(desktop): …` / `fix(review): …` / `docs(readme): …` / `build(mac): …`。结尾带 `Co-Authored-By` trailer。
- **提交 / 推送须经许可**：**未获用户明确许可，禁止 `git commit` 与 `git push`**——改完只把文件落盘，等用户明确指示再提交、再推送。此约束**不分改动类型、不分目标分支**（纯文档、`dev` 分支同样适用）；许可一次只对应一次操作，不默认延续到后续改动。
- **不提交无关改动**：工作区可能混有他人未提交编辑，按文件归属拆成内聚 commit，别混进同一条。
- **按文件显式暂存**：只 `git add` 自己本次改动的具体文件路径，**禁止 `git add -A` / `git add .` / `git add :/`** 整目录暂存。多个 agent 任务可能并行编辑同一工作区，全量暂存会把他人未完成的改动一并卷入。暂存后 `git status` 复核暂存区，确认只含本任务文件再提交。
- **PR 打标签**：开 / 更新 PR 后**习惯性打标签**——从仓库既有标签集（`gh label list`：enhancement / documentation / bug / …）选最贴切的一或多个贴上（`gh pr edit <n> --add-label`）。没有合适的现成标签时按需新建或留空并说明，不强凑。
- **平台展示顺序统一**：代码平台（GitHub / Bitbucket / GitLab …）在各处的展示顺序统一为 **GitHub → Bitbucket → GitLab**，**新增平台一律追加在末尾**。准绳是 [PlatformIcon.tsx](apps/desktop/src/renderer/src/components/PlatformIcon.tsx) 的 `PLATFORM_META` 数组；设置页平台下拉、首启向导网格、使用文档 [docs/guide/01-code-platform.md](docs/guide/01-code-platform.md)、`PlatformKind` 类型等各处均以此为序，改动平台清单时同步对齐，避免各处错位。

## 国际化 (i18n)

GUI 文本走 **react-i18next**（key 为中立标识符，`zh-CN` / `en-US` / `ja-JP` / `de-DE` 为**对等译文集**；**默认 / 兜底 `en-US`**，缺 key 回退英文）。设计、key 命名、翻译规范见 [docs/arch/03-gui/04-i18n](docs/arch/03-gui/04-i18n.md)。三条易踩（详见该篇）：

1. 新增文本各语言 locale 都加且保持**递归字典序**；
2. 复数只认 `count`（普通计数插值换别名）；
3. 勿开 `nonExplicitSupportedLngs`（按基码 `zh` 错位 → 整页裸 key）。

## 文档约定

- **两类文档分目录**：面向使用者的「使用说明」放 [docs/guide/](docs/guide/README.md)（**序号命名**，如 `01-code-platform.md`，README.md 作索引）；面向开发/agent 的模块设计文档放 [docs/arch/](docs/arch/README.md)。同一主题用户向与设计向各写一份，互相链接、不混写。
- **guide 双语、英文为正本**：`docs/guide/` 用户文档 EN + ZH——**英文占根**（`docs/guide/*.md`，规范/兜底正本），中文镜像在 `docs/guide/zh-CN/*.md`（同名同结构）。每篇顶部（H1 下）置语言切换行（英文 `**English** · [简体中文](zh-CN/x.md)`，中文 `[English](../x.md) · **简体中文**`）。**改内容须两语同步**，缺一即漂移。官网 [website/](website/README.md) 经 `scripts/sync-docs.mjs` 从二者构建（EN→`/guide/`、ZH→`/zh/guide/`，切换行构建期剥离），是**唯一渲染源**、勿另存副本。中文 README / arch 等中文文档链 guide 指向 `zh-CN/`，英文 README / `cli/` 等指向根。
- **书面化表达**：正式、简洁的书面语，避免口语化措辞（如「怎么配」→「配置方法」、「搞定」→「完成」）。
- **不用总结性套话**：避免「一句话」「总之」「简言之」「综上」这类收尾/概括套话，直接陈述结论。
- **示例力求通用**：能力性描述用通用表述 + 多个示例（如「本机 agentic CLI（claude / codex）」），不绑定单一品牌，便于扩展。

## 工程维护坑

- **新增内部 `@meebox/*` 包必做两步登记**（漏则报 `Cannot find module …/src/<x>.js`）：内部包源码是 `.ts`、相对 import 带 `.js` 扩展（NodeNext 约定），Node 运行期不能直接读。新建一个被 desktop 主/preload 引用的内部包后，除 `npm install`（建 workspace 软链）外**必须**：
  1. 在 `apps/desktop/package.json` 依赖加 `"@meebox/<name>": "*"`；
  2. 在 [apps/desktop/electron.vite.config.ts](apps/desktop/electron.vite.config.ts) 的 `internalPackages` 数组加该名——让 electron-vite 把它 **bundle**（转译 TS、解析 `.js`→`.ts`）而非 externalize。

  漏第 2 步时 Node 把它当外部包按 `main: src/index.ts` 加载，撞到 `export … from './x.js'` 而文件是 `.ts` → 运行期崩。
- **pr-agent 运行时 / shim**：嵌入式 CPython + pinned pr-agent 由 `assemble-pragent-runtime.mjs` 装到 `vendor/pragent`（gitignored）；对 pr-agent 的无侵入补丁在 `scripts/pragent-shim/`。机制与铁律（惰性 import 拆分 · 版本守卫 · 改后跑 `prepare:pragent` 同步 · 调试 `MEEBOX_SHIM_DEBUG=1`）见 [02-agent/05-pragent-runtime](docs/arch/02-agent/05-pragent-runtime.md)。弱网 pip 超时加 `PIP_DEFAULT_TIMEOUT=120`。
- **二进制资源走 Git LFS**（`*.png/.ico/.icns` 等）：本地没装 git-lfs 时拿到的是指针文件，electron-builder 转图标会崩 → `brew install git-lfs && git lfs pull`。
- **dev 起不来**：若 `npm run dev` 报 `electron does not provide an export named …`，是环境里有 `ELECTRON_RUN_AS_NODE=1`（VSCode 扩展宿主会注入）→ `unset ELECTRON_RUN_AS_NODE` 再跑。
- **grep 个别文件无输出**：如 `repo-mirror-manager.ts` 被 `file` 判为 `data`（含非 UTF-8 字节），普通 grep 静默 → 用 `grep -a`。
