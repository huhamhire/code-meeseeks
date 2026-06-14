# AGENTS.md

面向自动化编码 agent 的工程维护速览。背景/业务见 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/arch/](docs/arch/README.md)。

## 仓库结构

Electron 桌面应用 + npm workspaces + Nx 单仓多包。关键路径（`apps/desktop` 是主战场）：

```
apps/desktop/
├── src/
│   ├── main/              # 主进程：index.ts(启动/单例锁) · ipc.ts(IPC handlers) · adapters.ts · utils/
│   ├── preload/           # contextBridge 暴露泛型 invoke()
│   └── renderer/src/      # React 渲染层（components/ 等）
├── scripts/               # assemble-pragent-runtime.mjs · pragent-shim/(shim) · pragent-runtime.json
├── build-resources/       # after-pack.cjs(ad-hoc 签名) · entitlements.mac.plist
├── electron-builder.yml
└── vendor/pragent/        # 嵌入式运行时（gitignored，由 prepare:pragent 生成）

packages/<name>/src/index.ts  # 各库入口；shared 还含 ipc.ts(IPC 契约) · config.ts · poller-contract.ts
```

- `apps/desktop` —— Electron 应用（main + preload + renderer/React）。唯一有 `build`/`dist` 的项目。
- `packages/*` —— 内部库（`@meebox/*`），按职责拆分；其中 `shared` 含共享类型与 IPC 契约。
- `docs/arch/` 各模块设计文档（首选入口）；`docs/ROADMAP.md` 路线图；`tools/` 杂项脚本。

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

## 提交前必做

改完代码务必本地跑通这四步再收尾（CI 就是这套）：`lint` → `typecheck` → `test` → `build`。lint 零容忍（`--max-warnings=0`），warning 也会让 CI 红。

## 约定

- **TypeScript strict**；React 19 + electron-vite + Monaco。优先复用现有工具/类型，匹配周边代码风格与注释密度。
- **IPC**：main 用 `ipcMain.handle(channel, ...)`，renderer/preload 用泛型 `invoke<K>(channel, req)`，全部由 `packages/shared/src/ipc.ts` 的 `IpcChannels` 类型映射约束。新增通道先在那里加类型。
- **分支策略**：`master` 为发布分支，**禁止直接提交/修改**；所有特性与修复从 `dev` 拉分支开发，汇入 `dev` 验证后再合并到 `master`，发版在 `master` 打 `v*` tag 触发 release。
- **提交信息**：约定式提交、**中文**，带 scope，例：`feat(desktop): …` / `fix(review): …` / `docs(readme): …` / `build(mac): …`。结尾带 `Co-Authored-By` trailer。**改完不要自动提交**，等明确指示。
- **不提交无关改动**：工作区可能混有他人未提交编辑，按文件归属拆成内聚 commit，别混进同一条。
- **按文件显式暂存**：只 `git add` 自己本次改动的具体文件路径，**禁止 `git add -A` / `git add .` / `git add :/`** 整目录暂存。多个 agent 任务可能并行编辑同一工作区，全量暂存会把他人未完成的改动一并卷入。暂存后 `git status` 复核暂存区，确认只含本任务文件再提交。
- **PR 打标签**：开 / 更新 PR 后**习惯性打标签**——从仓库既有标签集（`gh label list`：enhancement / documentation / bug / …）选最贴切的一或多个贴上（`gh pr edit <n> --add-label`）。没有合适的现成标签时按需新建或留空并说明，不强凑。

## 国际化 (i18n)

GUI 文本走 **react-i18next**（key 为中立标识符，`zh-CN` / `en-US` / `ja-JP` / `de-DE` 为**对等译文集**，无源/译层级；UI 语言由 `config.language` 经 `resolveLanguage` 决定，空则按 OS 回落英语）。**默认 / 兜底语言取 `en-US`**（国际化标准：缺 key 回退英文而非中文）：渲染层 en-US 静态打包进入口 + 其余懒加载、`fallbackLng: 'en-US'`，主进程各持一份 locale、同样兜底 en-US。设计、key 命名、翻译规范见 [docs/arch/10-i18n](docs/arch/10-i18n.md)。三条易踩的：①新增文本须在**各语言 locale 都加**并保持**递归字典序**（日语复数同中文仅 `_other`、德语同英语需 `_one`/`_other`）；②i18next **只有 `count`** 触发复数，普通计数插值要换别的变量名；③**不要开 `nonExplicitSupportedLngs`**——它把 `zh-CN` 按基码 `zh` 查找、与按 `zh-CN` 注册的 bundle 错位 → 整页裸 key。

## 文档约定

- **两类文档分目录**：面向使用者的「使用说明」放 [docs/guide/](docs/guide/README.md)（**序号命名**，如 `01-code-platform.md`，README.md 作索引）；面向开发/agent 的模块设计文档放 [docs/arch/](docs/arch/README.md)。同一主题用户向与设计向各写一份，互相链接、不混写。
- **书面化表达**：正式、简洁的书面语，避免口语化措辞（如「怎么配」→「配置方法」、「搞定」→「完成」）。
- **不用总结性套话**：避免「一句话」「总之」「简言之」「综上」这类收尾/概括套话，直接陈述结论。
- **示例力求通用**：能力性描述用通用表述 + 多个示例（如「本机 agentic CLI（claude / codex）」），不绑定单一品牌，便于扩展。

## 工程维护坑

- **新增内部 `@meebox/*` 包必做两步登记**（漏则报 `Cannot find module …/src/<x>.js`）：内部包源码是 `.ts`、相对 import 带 `.js` 扩展（NodeNext 约定），Node 运行期不能直接读。新建一个被 desktop 主/preload 引用的内部包后，除 `npm install`（建 workspace 软链）外，**必须**：① 在 `apps/desktop/package.json` 依赖加 `"@meebox/<name>": "*"`；② 在 [apps/desktop/electron.vite.config.ts](apps/desktop/electron.vite.config.ts) 的 `internalPackages` 数组加该名——让 electron-vite 把它 **bundle**（转译 TS、解析 `.js`→`.ts`）而非 externalize。漏 ② 时 Node 把它当外部包按 `main: src/index.ts` 加载，撞到 `export … from './x.js'` 而文件是 `.ts` → 运行期崩。
- **嵌入式 pr-agent 运行时**（[modules/04](docs/arch/04-pragent-runtime.md)）：`apps/desktop/scripts/assemble-pragent-runtime.mjs` 按 `pragent-runtime.json` 把可重定位 CPython + pinned pr-agent 装到 `apps/desktop/vendor/pragent/`（gitignored）。
- **monkeypatch shim** `apps/desktop/scripts/pragent-shim/`（薄加载器 `sitecustomize.py` + 领域拆分包 `meebox_pragent_shim/`：`patches/` 各 patch + `cli/` 本地 CLI provider + `runtime.py`/`usage.py`。对 pr-agent 的无侵入补丁）：
  - 改了它，跑一次 `npm --prefix apps/desktop run prepare:pragent` 即重新同步进 vendor（幂等跳过分支也会同步 shim），**无需 `--force` 全量重建**。
  - 受版本守卫：`meebox_pragent_shim/runtime.py` 的 `_EXPECTED_PRAGENT_VERSION` 必须等于 `pragent-runtime.json` 的 `prAgent.version`（assemble 构建期强校验，运行期不符则跳过补丁 + stderr WARNING）。升级 pr-agent 要同步两处并重新验证。
  - **拆分铁律**：各 patch 对 `pr_agent` 的 import 一律放在 patch 函数体内（惰性）；模块顶层只 import 同包内的 runtime/usage 等，**绝不在顶层 import pr_agent**（否则 sitecustomize 阶段即 eager 加载，拖慢每次 python 启动）。
  - 调试：`MEEBOX_SHIM_DEBUG=1` 让 shim 打 stderr 调试。
- **二进制资源走 Git LFS**（`*.png/.ico/.icns` 等）：本地没装 git-lfs 时拿到的是指针文件，electron-builder 转图标会崩 → `brew install git-lfs && git lfs pull`。
- **dev 起不来**：若 `npm run dev` 报 `electron does not provide an export named …`，是环境里有 `ELECTRON_RUN_AS_NODE=1`（VSCode 扩展宿主会注入）→ `unset ELECTRON_RUN_AS_NODE` 再跑。
- **grep 个别文件无输出**：如 `repo-mirror-manager.ts` 被 `file` 判为 `data`（含非 UTF-8 字节），普通 grep 静默 → 用 `grep -a`。
- **prepare:pragent 网络**：pip 默认 15s 超时，弱网下加 `PIP_DEFAULT_TIMEOUT=120` 或配国内镜像（`~/.config/pip/pip.conf`）。
