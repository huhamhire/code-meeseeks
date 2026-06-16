# 10 · GUI 与交互

## 职责与边界

渲染层（React）的整体布局、各面板职责、跨 PR 状态保活与关键交互约定。渲染层只做展示与交互，
所有数据/IO 经 IPC 调主进程（见 [00 · 架构总览](00-overview.md)）。

负责：UI 结构、面板交互、前端状态保活、外链/模态/本地偏好等交互规范。不负责：业务逻辑与 IO（在主进程各模块）。

## 核心设计

### 布局

根组件挂载后做一次 bootstrap（并行拉 app 信息 / 配置 / PR 列表 / pr-agent 状态 / 连接 / 上次同步），
之后是自绘标题栏 + 三栏 + 状态栏的主界面，外加按需浮层：

- **TitleBar（顶）**：无边框窗口的自绘标题栏（见下「无边框窗口」），展示品牌名 + 选中 PR 标题，整条可拖拽窗口。
- **Sidebar（左）**：待评审 PR 列表，按 `项目/仓库` 分组 + 手风琴折叠，updatedAt 倒序，状态过滤 + 搜索；
  宽度可拖拽、可整体收起。
- **MainPane（中）**：选中 PR 的详情，分「变更 / 评论 / 提交 / 详情」标签页。变更页即 **DiffView**。
- **ChatPane（右）**：对话式驱动 pr-agent（`/describe` `/review` `/ask`），默认收起；宽度可拖拽。
- **StatusBar（底）**：pr-agent 状态 / 队列、仓库同步进度、最近同步时间、当前 LLM 等胶囊。
- **浮层**：SettingsModal（设置）、OnboardingWizard（首启向导）、各确认/编辑二层模态、操作级 toast。

### 关键面板

- **DiffView**：Monaco 并排 diff + 文件树（图标/Git 着色/草稿与评论 chip）+ 行内评论（view zone）+
  blame + 跨文件搜索 + 行内草稿编辑（DraftZone）。文件切换只渲染当前文件。
- **ChatPane**：run 卡片（RunMeta 显示模型名 + ↑输入/↓输出 token）；finding 卡片可「→ 编辑」（跳 Diff
  并进入草稿编辑）/「✗ 拒绝」；队列串行、可中断/重试；命令补全 + 历史。
- **DraftsPanel**：「草稿」标签页，跨文件浏览草稿，单条/批量发布，与「评论」标签对照本地未发 vs 远端已发。
- **SettingsModal**：连接 / LLM / 代理 / 规则目录 / 轮询 / repos_dir 的可视化 CRUD，子项用二层编辑模态；
  连接/代理带「测试」。
- **OnboardingWizard**：首启引导配代码平台（+ 可选 LLM）。

### 跨 PR 状态保活

pr-agent run 的实时状态、仓库同步、草稿都用**模块级 store**（`useSyncExternalStore`）持有，并在根组件
启动时把主进程的事件流（run 进度 / 队列变化 / 同步进度 / 草稿变化）接入。这样切换 PR 时运行中的状态、
实时 stdout、草稿列表不随组件卸载丢失。

### 无边框窗口

主窗口去掉系统原生标题栏（`titleBarStyle: 'hidden'`），由渲染层自绘一条 36px 标题栏（VS Code 风），
让深色主题从顶贯通到底。窗控按钮**不自绘**，交由系统画以保留原生行为（Snap Layouts / 双击最大化 / 吸附）：

- **macOS**：保留红绿灯，`trafficLightPosition` 下移到自绘标题栏内；标题栏左侧留 72px 占位避让。
- **Windows / Linux**：`titleBarOverlay` 让系统在右上画最小化/最大化/关闭，渲染层只接管中间标题区，
  **勿在右上角放可点元素**（会被 overlay 覆盖）。`titleBarOverlay.height` 必须与渲染层 `.app-titlebar` 高度（36px）一致。

拖拽实现：整条标题栏 `-webkit-app-region: drag`，其中的按钮/链接/输入等交互元素各自 `no-drag`，否则点击被当成拖窗。

平台差异经 `AppInfo.platform`（bootstrap 时由主进程下发）判定，渲染层不直接读 `process`。

### 交互约定

- **外链统一外开**：所有 UGC（评论 / PR 描述 / finding / chat）里的 `http(s)` 链接点击都走系统默认浏览器
  （capture 阶段全局拦截 + `app:openExternal`），不在应用窗口内导航覆盖界面。
- **二层模态背景点击只关本层**：嵌套模态（连接/LLM/代理编辑、确认框）的 backdrop 点击 `stopPropagation`，
  不冒泡到外层设置模态的关闭（含 createPortal 的确认框，React 合成事件仍按组件树冒泡）。
- **操作级 toast vs 整屏错误**：远端动作（审批/合并/发布）失败弹 toast，区别于 bootstrap 致命错误的整屏报错。
- **窗口聚焦自动刷新**：窗口重新获得焦点时主动拉一次 PR meta（跟上「切到平台改完再切回」场景）。
- **布局偏好持久化**：侧栏/对话宽度与折叠态、diff 视图模式等存 localStorage。

## 数据 / 接口契约

- 渲染层经 preload 暴露的泛型 `invoke<K>(channel, req)` 调主进程；事件订阅经 `subscribe(event, cb)`。
  全部由 `IpcChannels` 类型映射约束（见 [00](00-overview.md)）。
- 领域类型（PR / Finding / ReviewRun / Draft / 配置）来自 `shared`，前后端共享。

## 扩展与注意事项

- **新交互一律走 IPC + 类型映射**：渲染层不直接碰 Node / 文件 / 网络。
- **跨 PR 需存活的状态进模块级 store**，不要塞组件 useState（切 PR 即丢）。
- **安全基线**：`contextIsolation` 开、无 `nodeIntegration`、CSP；preload 只暴露白名单能力。
- **二层模态**新增时记得 backdrop `stopPropagation`，否则会连带关掉外层。
- **无边框标题栏高度**改动时，渲染层 `.app-titlebar` 与主进程 `titleBarOverlay.height` 两处须同步，否则 Windows 窗控与标题区错位；标题栏内新增交互元素记得标 `no-drag`。
- Monaco 的 worker、view zone（行内评论/草稿）渲染较重，注意大 PR 下的懒加载与销毁。
