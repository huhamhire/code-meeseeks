import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Notification } from 'electron';
import type { Logger } from 'pino';
import type { Config, PollNotificationEvent } from '@meebox/shared';
import { t } from '../i18n/index.js';
import { broadcast } from './broadcast.js';
import { ensureAvatarFile, type AvatarFileDeps } from './avatar.js';

/**
 * 系统通知 + 应用角标。两条路径：
 * - 系统通知（toast）：poll 投影的本轮事件按类型开关弹原生通知；受 OS 权限约束，用户在系统设置关闭后静默降级。
 *   Windows 走 toastXml 富样式（圆形发起人头像 + 类型 emoji + 仓库行）；其他平台用 title/body 文本（含仓库，无头像，
 *   因 Electron 在 macOS 固定显示应用图标、不支持 per-notification 头像）。
 * - dock 角标（本期仅 macOS）：renderer 据 PR 列表派生「待回应」计数后推送，主进程落地到 dock 图标。
 *
 * 文案走主进程 i18n（与 dialog / pr-agent 同一实例，语言随启动配置定档）。
 */

/** 一轮最多单独弹的通知条数（各带定位）；超出部分折叠为一条「查看更多」提示，避免涌入时的通知风暴。 */
const INDIVIDUAL_LIMIT = 5;

/** 通知事件类型 → i18n 文案分组名（new_pr 的 key 为 newPr，其余同名）。 */
const I18N_GROUP: Record<PollNotificationEvent['kind'], string> = {
  new_pr: 'newPr',
  mention: 'mention',
  reply: 'reply',
};

/** 类型 emoji（Windows toast 单图标槽给了头像，故类型用 emoji 在标题前标记）。 */
const TYPE_EMOJI: Record<PollNotificationEvent['kind'], string> = {
  new_pr: '🔀',
  mention: '💬',
  reply: '↩️',
};

/** 点击通知：唤起并聚焦主窗口（最小化则先还原）。 */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showNotification(
  options: Electron.NotificationConstructorOptions,
  onClick: () => void = focusMainWindow,
): void {
  const n = new Notification(options);
  n.on('click', onClick);
  n.show();
}

/** 点击通知 → 聚焦窗口 + 推导航意图给 renderer（选中 PR / 跳 diff 行 / 开活动标签，见 IpcEvents['notification:activate']）。 */
function activateOnClick(e: PollNotificationEvent): () => void {
  return () => {
    focusMainWindow();
    broadcast('notification:activate', {
      localId: e.localId,
      kind: e.kind,
      anchor: e.comment?.anchor
        ? { path: e.comment.anchor.path, line: e.comment.anchor.line }
        : null,
    });
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 构造 Windows ToastGeneric XML：标题（emoji+类型）+ 正文（#编号 标题）+ 归属行（仓库）+ 圆形头像（可选）。 */
function buildToastXml(line1: string, line2: string, attribution: string, avatarPath: string | null): string {
  const logo = avatarPath
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(pathToFileURL(avatarPath).href)}"/>`
    : '';
  return (
    `<toast><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(line1)}</text>` +
    `<text>${escapeXml(line2)}</text>` +
    `<text placement="attribution">${escapeXml(attribution)}</text>` +
    logo +
    `</binding></visual></toast>`
  );
}

/** 弹单条通知：Windows 富样式（头像 + emoji + 仓库），失败 / 其他平台回退为 title/body 文本（含仓库）。 */
async function showOne(
  e: PollNotificationEvent,
  avatarDeps: AvatarFileDeps,
  logger: Logger,
): Promise<void> {
  const group = I18N_GROUP[e.kind];
  const title = t(`notifications.${group}.title`);
  const body = t(`notifications.${group}.body`, { id: e.remoteId, title: e.title });
  const repo = `${e.repo.projectKey}/${e.repo.repoSlug}`;

  const onClick = activateOnClick(e);
  if (process.platform === 'win32') {
    try {
      const avatarPath = await ensureAvatarFile(
        avatarDeps,
        e.connectionId,
        e.actor.slug ?? e.actor.name,
        e.actor.avatarUrl,
      );
      showNotification(
        { toastXml: buildToastXml(`${TYPE_EMOJI[e.kind]} ${title}`, body, repo, avatarPath) },
        onClick,
      );
      return;
    } catch (err) {
      logger.warn({ err }, 'failed to build rich toast; falling back to plain notification');
    }
  }
  showNotification({ title, body: `${body}\n${repo}` }, onClick);
}

/**
 * 按通知配置弹系统通知。总开关关 / 平台不支持通知 → 直接返回（静默降级）。按类型开关过滤后：
 * 最多前 {@link INDIVIDUAL_LIMIT} 条逐条弹（各带头像富样式 + 点击定位）；超出部分（第 6 条起）折叠为一条
 * 「查看更多最新动态」提示，点击仅打开主界面、不做定位。
 */
export async function showPollNotifications(
  events: ReadonlyArray<PollNotificationEvent>,
  config: Config,
  logger: Logger,
  avatarDeps: AvatarFileDeps,
): Promise<void> {
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
    const shown = filtered.slice(0, INDIVIDUAL_LIMIT);
    for (const e of shown) {
      await showOne(e, avatarDeps, logger);
    }
    const overflow = filtered.length - shown.length;
    if (overflow > 0) {
      // 溢出提示：点击走默认 focusMainWindow（仅打开主界面、不定位），让用户自行查看更多最新动态。
      showNotification({
        title: t('notifications.more.title'),
        body: t('notifications.more.body', { count: overflow }),
      });
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
