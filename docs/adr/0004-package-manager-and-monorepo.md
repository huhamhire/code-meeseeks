# ADR-0004: 包管理器与 Monorepo 工具

- **状态**：Accepted
- **日期**：2026-05-28
- **决策者**：项目主导

## 背景

pr-pilot 采用 monorepo 结构（`apps/desktop` + 多个 `packages/*`），需要确定两个工具选择：

1. JS 包管理器：npm / yarn / pnpm
2. Monorepo 任务编排：Turborepo / Nx / 自研脚本 / 无

ROADMAP 草案曾提及 "pnpm + turborepo/nx"，未做最终决策。

## 决策驱动因素

1. **安装门槛**：开发者 `git clone` 后能立即开干，少一个全局工具是一个
2. **任务编排**：`build` / `lint` / `test` 需要按依赖顺序跑 + 缓存 + 受影响子集探测
3. **代码生成**：未来加 `platform-github` / `platform-gitlab` 包时，希望有模板支撑
4. **Electron + Vite 兼容性**：实测稳定的工具链优先于"理论上更先进"的
5. **学习曲线**：本项目个人/小团队级别，工具复杂度不应超过业务代码

## 候选方案

### A. pnpm + Turborepo

- ✅ pnpm 严格依赖隔离 + 内容寻址存储省磁盘
- ✅ Turborepo 轻量，上手快
- ❌ 多一个 pnpm 全局安装步骤（虽然 corepack 能缓解）
- ❌ Turborepo 只有 caching + task pipeline，缺代码生成和依赖图工具

### B. npm + Nx（**决策**）

- ✅ npm 随 Node 自带，零额外全局安装
- ✅ Nx 有 generators (`nx g`) 便于加新包
- ✅ Nx 自带 dep graph、computation cache、affected 检测、IDE 插件 (Nx Console)
- ✅ Electron / Vite / React 都有官方或社区 plugin
- ❌ Nx 学习曲线略陡（但只用核心 6–8 个命令足矣）
- ❌ npm workspaces 不如 pnpm 严格（理论上同仓内可访问未声明依赖；通过 lint 规则约束）

### C. yarn berry + 自研脚本

- ❌ PnP 模式跟 Electron / Vite 兼容性历史踩坑多
- ❌ 自研脚本意味着重复造轮子

## 决策

**采用 npm workspaces + Nx**。

### 工程约定

- **npm 版本**：>= 10（Node 20 LTS 自带）；锁定到根 `package.json` 的 `engines` 字段
- **workspaces**：根 `package.json` 声明 `"workspaces": ["apps/*", "packages/*"]`
- **包结构**：
  ```
  apps/
    desktop/                # Electron 主应用（壳 + Renderer 入口）
  packages/
    shared/                 # 跨包共享类型、工具、常量
    platform-bitbucket/     # BitbucketServerAdapter
    pr-agent-bridge/        # PrAgentBridge (LocalCli / Docker)
    state-store/            # StateStore + JsonFileStateStore
    config/                 # 配置 + SecretStore
    ui-kit/                 # 共享 UI 组件（按需引入）
  ```
- **Nx 任务**：`build` / `lint` / `test` / `typecheck` 统一注册，走 `nx run-many` 调度
- **CI**：使用 `nx affected --target=<task>` 只跑变更影响包
- **依赖归属规则**（缓解 npm 不严格的问题）：
  - 业务运行时依赖写到对应子包 `package.json`
  - 构建/测试工具（typescript、eslint、vitest、prettier 等）写到根 `package.json` 的 `devDependencies`
  - 引入 `eslint-plugin-import` + `no-extraneous-dependencies` 规则强制约束

### 不引入的能力（暂不用，按需开启）

- **Nx Cloud**（远程缓存）：本地够用，CI 慢到不能忍时再开
- **Module Federation**：Electron 单 bundle 足够
- **Nx Release**：M5 之前手动打 tag 即可
- **自定义 Nx Plugin**：除非有重复脚手架需求

## 后果

### 正面

- 开发者 `git clone && npm install && npx nx run desktop:dev` 即可启动
- 加新平台 Adapter：`nx g @nx/js:library platform-github` 一键生成
- CI 用 `nx affected` 缩短反馈周期，PR 改 README 不应触发 desktop 全量构建
- Nx Console（VSCode/IntelliJ）和 `nx graph` 让架构对新人可视化

### 负面

- npm workspaces 的 hoisting 偶尔模糊"依赖该写哪一层"，需 lint 规则兜底
- Nx 大版本升级偶有破坏性变更，需关注 changelog
- 若将来要把某些 `packages/*` 发布到 npm 公开 registry，需补 Nx Release 配置

## 验证（M0 完成时）

- [ ] `npm install` 安装所有 workspace 依赖
- [ ] `npx nx graph` 展示依赖图
- [ ] `npx nx run-many -t build` 全量构建通过
- [ ] `npx nx affected -t test --base=main` 在 PR 上只跑受影响测试
- [ ] `npx nx run desktop:dev` 启动 Electron
