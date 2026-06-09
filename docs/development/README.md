# 开发指南

面向贡献者 / 自行构建的开发者。产品介绍见根 [README](../../README.md)，架构与里程碑见 [ROADMAP](../ROADMAP.md)。

> 本目录（`docs/development/`）是**开发专题**：本指南为入口，另含 [打包与发布](./packaging-release.md)（含 CI）与 [macOS 构建与发布](./mac-build.md)。模块/子系统设计见 [`../modules/`](../modules/)。

> 代码内部统一用中性代号 **meebox**（npm 作用域 `@meebox/*`），对外品牌为 Code Meeseeks。
> 数据目录 `~/.code-meeseeks/`。上游 pr-agent 为第三方依赖，不在重命名范围内。

## 1. 前置环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（开发用 22） | 见根 `package.json` engines |
| npm | ≥ 10 | 用 workspaces，勿用 pnpm/yarn |
| Git | 任意近期版本 | 仓库镜像 + diff 走系统 `git` |

打包时还会用到（已作为 devDependencies 安装，无需系统级安装）：内嵌运行时下载走 `undici` + `tar`，无需系统 `curl` / `python` / `docker`。

> **代理**：`prepare:pragent` 会从 GitHub 下载 python-build-standalone。若在受限网络下，设置 `HTTPS_PROXY` 环境变量，或给脚本传 `--proxy http://host:port`。

## 2. 安装依赖

```bash
git clone <repo-url>
cd <repo>
npm ci          # 安装全部 workspace 依赖
```

仓库用 **Git LFS** 跟踪图标 / 图片（见根 `.gitattributes`）。若 clone 后图片显示为指针文本：

```bash
git lfs pull
```

## 3. 组装内嵌 pr-agent 运行时（首次必跑）

应用默认走 `embedded` 策略：内嵌一份可重定位 CPython + 固定版本 pr-agent。开发态启动前需先组装：

```bash
npm --prefix apps/desktop run prepare:pragent
```

- 产物落在 `apps/desktop/vendor/pragent/`（已 gitignore，约 600+ MB）。
- 幂等：已组装则跳过；`--force` 强制重建。
- 平台自动识别：Windows x64 / macOS arm64（详见 [打包与发布](./packaging-release.md)）。
- 此脚本需 **Node 22+**（用到较新内置能力）；其余开发命令 Node 20 即可。

## 4. 启动开发态

```bash
npm --prefix apps/desktop run dev    # electron-vite dev（HMR）
```

首次启动会自动创建 `~/.code-meeseeks/` 工作目录 + 默认 `config.yaml`。在设置页或直接编辑该文件配置 Bitbucket Server 连接与 LLM Provider。

> 改动 **main 进程 / workspace 包** 代码后，HMR 不一定生效，需重启 `dev`。renderer 代码热更正常。

## 5. 常用脚本

仓库用 Nx 编排，根目录脚本对所有包生效：

```bash
npm run build        # nx run-many -t build
npm run typecheck    # 全包类型检查
npm run test         # vitest（nx run-many -t test）
npm run lint         # eslint
npm run format       # prettier 写入
npm run graph        # nx 依赖图
```

单包可加 `nx` 前缀，例如：

```bash
npx nx typecheck @meebox/desktop
npx nx test @meebox/poller
```

## 6. 打包安装包

```bash
# Windows：出 NSIS 安装包到 apps/desktop/release/
npm --prefix apps/desktop run dist

# 仅打 unpacked 目录（更快的烟雾测试，不出安装器）
npm --prefix apps/desktop run pack
```

`dist` = `prepare:pragent` + `electron-vite build` + `electron-builder`。

- **图标**：源在 `assets/icons/`，electron-builder 显式引用（`win.icon` 指向 `icon.ico`）。重新生成 `.ico` 见 [assets/README](../../assets/README.md)。
- **macOS**：签名 / 公证 / 免费 ad-hoc 路线见 [macOS 构建与发布](./mac-build.md)。
- **CI 发布**：推 `v*` tag 触发自动出 Windows + macOS(arm64) 包并挂 Release。统一的构建/签名/CI 设计见 [打包与发布](./packaging-release.md)（workflow: [.github/workflows/release.yml](../../.github/workflows/release.yml)）。

## 7. 仓库结构

```
.
├── apps/
│   └── desktop/                    # Electron 应用（main / preload / renderer）
│       ├── scripts/                # 内嵌运行时组装脚本 + sitecustomize shim
│       ├── build-resources/        # 打包资源（entitlements / afterPack 钩子）
│       └── vendor/pragent/         # 内嵌运行时（gitignore，prepare:pragent 生成）
├── packages/
│   ├── shared/                     # 跨进程共享类型 / IPC 契约 / config schema
│   ├── config/                     # 配置加载与校验
│   ├── logger/                     # pino 日志
│   ├── platform-bitbucket-server/  # Bitbucket Server 平台适配
│   ├── poller/                     # PR 轮询发现 + 草稿池
│   ├── pr-agent-bridge/            # pr-agent 调用（embedded / local-cli 策略）
│   ├── repo-mirror/                # 仓库镜像（partial clone + diff/blame）
│   ├── rules/                      # 规则目录加载与匹配
│   └── state-store/                # JSON 状态存储（原子写）
├── docs/                           # ROADMAP / modules 设计 / development 开发专题
├── assets/                         # 品牌 / 图标资源（LFS）
└── tools/                          # 探针等辅助脚本
```

## 8. 数据目录

应用数据固定在 `~/.code-meeseeks/`（跨 OS 一致）：

```
~/.code-meeseeks/
├── config.yaml      # 连接 / LLM / repos_dir 等全部配置（含明文凭据，权限收紧）
├── state/           # PR 元数据 / 评论缓存 / 评审 run / 草稿（per-PR 目录）
├── logs/            # 滚动日志
└── repos/           # 仓库镜像（默认位置，repos_dir 可改到其它盘）
```

数据模型与容错设计见 [arch/03 状态存储与数据模型](../arch/03-state-storage.md)。

## 9. 测试约定

- 新建包的测试放包内 `tests/` 目录，从 `'../src/...'` 引入（旧包遗留在 `src/` 的不强制迁移）。
- 提交前跑 `npm run typecheck && npm run test`。

## 10. 调试技巧

### 强制进入首启配置向导

首启向导只在「没有有效的 active 连接」时出现。已经配好连接后想反复调试向导，用 localStorage 开关（不动配置、可反复切换）：

应用运行中打开 DevTools（设置页「打开 DevTools」或主进程菜单），在 Console 执行：

```js
localStorage.setItem('meebox.forceOnboarding', '1'); location.reload();
```

刷新后即进入向导。走完向导（点「进入应用」）会自动清掉该 flag 回到主界面；也可手动关闭：

```js
localStorage.removeItem('meebox.forceOnboarding'); location.reload();
```

### 首启向导里打开 DevTools

首启向导没有菜单 / 状态栏入口。欢迎页（第 1 步）**连续点击 logo 7 次**（每次间隔 < 800ms）即可打开 DevTools，用于在向导阶段排障。
