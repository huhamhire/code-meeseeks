# 消息通知（系统通知 + dock 角标）

把「与我相关」的事件从应用内提示扩展到操作系统层：被 @、被回复、有新 PR 时弹原生系统通知（toast），并在 macOS dock 图标上显示「待回应」计数角标。用户向使用说明见 [docs/guide/](../guide/README.md)；列表内的未读点名计数见 [03-state-storage](03-state-storage.md) 的「未读点名计数」。

## 范围（本期）

- **系统通知（toast）**：Windows + macOS 原生通知，按事件类型（新 PR / 评论回复 / 评论 @）分别开关。
- **macOS dock 角标**：dock 图标上显示「@我 / 回复我」待回应总数。
- 常驻状态栏 / Windows 任务栏 overlay 与闪烁本期不做（成本偏重，留待后续）。

## 两条数据路径

### 1. 系统通知：poll 事件投影 → 主进程 toast

- **投影（poller）**：`pollOnce` 在常规扫描中顺带产出本轮「值得提醒」事件 `PollNotificationEvent[]`（`kind: new_pr | mention | reply` + PR 标识/标题 + 条数），经 `onNotify` 回调交主进程。复用既有评论拉取（仅 PR `updatedAt` 跳变时扫），**无额外网络**。
  - **新 PR**：`isAdded` 的 PR。
  - **@ / 回复**：评论扫描用 [`collectMentionsToMe`](../../packages/poller/src/unread.ts)（按「父评论作者是我=reply / 正文 @我=mention」分类，每条命中带评论作者），取**晚于历史游标 `lastMentionAt`** 的命中、按类型聚合条数。
  - 事件还带 `repo` / `connectionId` / `actor`（发起人：new_pr=PR 作者，mention/reply=该类最新一条命中的评论作者），供富样式通知用。
- **防风暴**：仅在**已有基线**（本轮之前索引非空）时产出事件——首启 / 清库后的首轮只建基线、不弹通知；新发现 PR 的历史评论不投影为 mention/reply（`prev` 不存在则跳过）。
- **仅「待处理」**：事件只对 `localStatus === 'pending'` 的 PR 产出（投影处 `notifiable = hadBaseline && localStatus === 'pending'` 门控）——已 approve / 标记 needs_work 的 PR 不再打扰。
- **点击定位**：mention/reply 事件带 `comment`（最新一条命中评论的 `remoteId` + `anchor`），供点击跳转。
- **落地（main）**：[`services/notifications.ts`](../../apps/desktop/src/main/services/notifications.ts) 的 `showPollNotifications` 经 `bootstrap/poller.ts` 的 `onNotify` 接线。按通知配置（总开关 + 分类型）过滤后：不超过阈值逐条弹，超出聚合为一条「N 条新动态」摘要。点击通知唤起并聚焦主窗口。文案走主进程 i18n（`notifications.*`）。
- **样式**：
  - **Windows** 走 `toastXml` 富样式（ToastGeneric）：圆形发起人头像（`appLogoOverride` + `hint-crop="circle"`）+ 标题行带类型 emoji（🔀 PR / 💬 @ / ↩️ 回复）+ 正文 `#编号 标题` + 归属行仓库 `项目/仓库`。toast 仅一个小图标槽，故头像占槽、类型用 emoji 标记。
  - **头像**：[`services/avatar.ts`](../../apps/desktop/src/main/services/avatar.ts) 的 `ensureAvatarFile` 按 `(connectionId, slug)` 复用头像磁盘缓存（与 `app:userAvatar` 同约定），缺失则经 adapter 拉取落盘；因 toast `<image src>` 需本地文件 + 可识别扩展名，在裸字节 `.bin` 之外按嗅探的 content-type 旁挂一份 `.png`/`.jpg`。svg / 未知格式或拉取失败时降级为无头像。
  - **其他平台**：用 `title` / `body` 文本（body 附带仓库行），不含头像——Electron 在 macOS 固定显示应用图标、不支持 per-notification 头像。Windows toastXml 构造失败也回退到此文本路径。
- **头像接线**：`onNotify` 经 `createPoller` 的 `getConnectionRuntime`（惰性 getter，poller 早于连接运行时构建）按 `connectionId` 取 adapter 拉头像。

### 点击导航

通知点击除聚焦窗口外，主进程经 `broadcast('notification:activate', { localId, kind, anchor })` 推导航意图（`anchor` = inline 评论的 `{path,line}`，否则 null）。renderer（App.tsx 订阅）据此：定位目标 PR（不在活跃列表则忽略）→ 切回活跃范围 + 必要时切到含它的发现分类 → 选中并标已读 → 再按类型定位：

- **new_pr**：仅选中该 PR；
- **inline 评论**（anchor 非空）：经 `pendingDiffNav` 切 Diff 标签并跳到该文件行（复用 finding/草稿跳转通道）；
- **summary 评论**（anchor 为 null）：经 PrPanel 的 `pendingTab` 切到「活动」对话标签（不做评论级精确滚动）。

### 2. dock 角标：renderer 派生 → 主进程落地

- renderer [`useDockBadge`](../../apps/desktop/src/renderer/src/hooks/useDockBadge.ts) 据活跃 PR 列表的 `unreadMentionCount` 求和（各 PR 已封顶 10），随通知总开关 `enabled` 门控（关则置 0；角标无独立开关），经 `app:setBadgeCount` 推给主进程；[`applyBadgeCount`](../../apps/desktop/src/main/services/notifications.ts) 仅在 macOS 调 `app.setBadgeCount`。
- 计数源自 renderer 已派生的数据（避免主进程重复从状态库派生），故放在渲染层 hook、随 PR 列表 / 配置变化重算。

## 配置

`config.notifications`（[config.ts](../../packages/shared/src/config.ts)，写入走 `config:setNotifications`、设置页「通知」分区）：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关；关闭后既不弹系统通知也不亮 dock 角标 |
| `new_pr` / `reply` / `mention` | 分类型系统通知开关 |

macOS dock「待回应」计数角标随总开关默认启用，无独立配置项。

## OS 权限约束

- **macOS**：首次弹通知由系统接管授权，应用无法强制开启；用户在「系统设置→通知」关闭后只能静默降级（`Notification.isSupported()` 探测，被关即不弹）。当前为 ad-hoc 签名、未公证（见 [packaging-release](../development/packaging-release.md)），通知可工作但归属标识不如 Developer ID + 公证可靠。
- **Windows**：toast 依赖 `AppUserModelId`（与安装包 `appId` 一致，启动时设定），否则可能不显示；无弹窗式授权。
- dock 角标免权限。
