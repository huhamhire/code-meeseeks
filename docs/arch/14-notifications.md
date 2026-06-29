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
  - **@ / 回复**：评论扫描用 [`collectMentionsToMe`](../../packages/poller/src/unread.ts)（按「父评论作者是我=reply / 正文 @我=mention」分类），取**晚于历史游标 `lastMentionAt`** 的命中、按类型聚合条数。
- **防风暴**：仅在**已有基线**（本轮之前索引非空）时产出事件——首启 / 清库后的首轮只建基线、不弹通知；新发现 PR 的历史评论不投影为 mention/reply（`prev` 不存在则跳过）。
- **落地（main）**：[`services/notifications.ts`](../../apps/desktop/src/main/services/notifications.ts) 的 `showPollNotifications` 经 `bootstrap/poller.ts` 的 `onNotify` 接线。按通知配置（总开关 + 分类型）过滤后：不超过阈值逐条弹，超出聚合为一条「N 条新动态」摘要。点击通知唤起并聚焦主窗口。文案走主进程 i18n（`notifications.*`）。

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
