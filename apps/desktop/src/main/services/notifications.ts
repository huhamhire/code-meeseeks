import { app, BrowserWindow, Notification } from 'electron';
import type { Logger } from 'pino';
import type { Config, PollNotificationEvent } from '@meebox/shared';
import { t } from '../i18n/index.js';

/**
 * 系统通知 + 应用角标。两条路径：
 * - 系统通知（toast）：poll 投影的本轮事件按类型开关弹原生通知；受 OS 权限约束，用户在系统设置关闭后静默降级。
 * - dock 角标（本期仅 macOS）：renderer 据 PR 列表派生「待回应」计数后推送，主进程落地到 dock 图标。
 *
 * 文案走主进程 i18n（与 dialog / pr-agent 同一实例，语言随启动配置定档）。
 */

/** 一轮最多单独弹的通知条数；超出聚合为一条「N 条新动态」摘要，避免涌入时的通知风暴。 */
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

/** 通知事件类型 → i18n 文案分组名（new_pr 的 key 为 newPr，其余同名）。 */
const I18N_GROUP: Record<PollNotificationEvent['kind'], string> = {
  new_pr: 'newPr',
  mention: 'mention',
  reply: 'reply',
};

/** 点击通知：唤起并聚焦主窗口（最小化则先还原）。 */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function fire(title: string, body: string): void {
  const n = new Notification({ title, body });
  n.on('click', focusMainWindow);
  n.show();
}

/**
 * 按通知配置弹系统通知。总开关关 / 平台不支持通知 → 直接返回（静默降级）。按类型开关过滤后：
 * 不超过 {@link MAX_INDIVIDUAL_NOTIFICATIONS} 条逐条弹，超出聚合成一条摘要。
 */
export function showPollNotifications(
  events: ReadonlyArray<PollNotificationEvent>,
  config: Config,
  logger: Logger,
): void {
  const cfg = config.notifications;
  if (!cfg.enabled || !Notification.isSupported()) return;
  const allow: Record<PollNotificationEvent['kind'], boolean> = {
    new_pr: cfg.new_pr,
    reply: cfg.reply,
    mention: cfg.mention,
  };
  const filtered = events.filter((e) => allow[e.kind]);
  if (filtered.length === 0) return;
  logger.info({ count: filtered.length }, 'showing system notifications');
  try {
    if (filtered.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
      fire(
        t('notifications.summary.title'),
        t('notifications.summary.body', { count: filtered.length }),
      );
      return;
    }
    for (const e of filtered) {
      const group = I18N_GROUP[e.kind];
      fire(t(`notifications.${group}.title`), t(`notifications.${group}.body`, {
        id: e.remoteId,
        title: e.title,
      }));
    }
  } catch (err) {
    logger.warn({ err }, 'failed to show system notification');
  }
}

/**
 * 设置应用角标计数（本期仅 macOS dock）。count≤0 清除角标。renderer 已据通知配置派生计数，主进程仅落地。
 */
export function applyBadgeCount(count: number): void {
  if (process.platform !== 'darwin') return;
  app.setBadgeCount(Math.max(0, Math.floor(count)));
}
