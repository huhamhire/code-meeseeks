import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Notification } from 'electron';
import type { Logger } from 'pino';
import type { Config, PollNotificationEvent } from '@meebox/shared';
import { t } from '../i18n/index.js';
import { broadcast } from './broadcast.js';
import { ensureAvatarFile, type AvatarFileDeps } from './avatar.js';

/**
 * System notifications + app badge. Two paths:
 * - System notification (toast): this round's poll-projected events fire native notifications per type toggle; subject to OS permission, silently degrades after the user disables it in system settings.
 *   Windows uses toastXml rich style (circular initiator avatar + type emoji + repo line); other platforms use title/body text (with repo, no avatar,
 *   because Electron fixes the app icon on macOS and does not support per-notification avatars).
 * - dock badge (macOS only this iteration): renderer derives the "awaiting response" count from the PR list and pushes it, the main process lands it on the dock icon.
 *
 * Text goes through main-process i18n (same instance as dialog / pr-agent, language fixed by startup config).
 */

/** Max number of notifications fired individually per round (each with anchoring); the overflow is collapsed into one "see more" prompt, avoiding a notification storm on influx. */
const INDIVIDUAL_LIMIT = 5;

/** Notification event type → i18n text group name (new_pr's key is newPr, authored_* is camel-cased, the rest same name). */
const I18N_GROUP: Record<PollNotificationEvent['kind'], string> = {
  new_pr: 'newPr',
  mention: 'mention',
  reply: 'reply',
  authored_comment: 'authoredComment',
  authored_needs_work: 'authoredNeedsWork',
  authored_conflict: 'authoredConflict',
};

/** Type emoji (the Windows toast single icon slot is given to the avatar, so the type is marked with an emoji before the title). */
const TYPE_EMOJI: Record<PollNotificationEvent['kind'], string> = {
  new_pr: '🔀',
  mention: '💬',
  reply: '↩️',
  authored_comment: '💬',
  authored_needs_work: '📝',
  authored_conflict: '⚠️',
};

/** On notification click: raise and focus the main window (restore first if minimized). */
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

/** On notification click → focus the window + push a navigation intent to the renderer (select PR / jump to diff line / open activity tab, see IpcEvents['notification:activate']). */
function activateOnClick(e: PollNotificationEvent): () => void {
  return () => {
    focusMainWindow();
    broadcast('notification:activate', {
      localId: e.localId,
      kind: e.kind,
      anchor:
        // File-level comments (no line) aren't line-navigable → no anchor (clicking just opens the PR).
        e.comment?.anchor && e.comment.anchor.line != null
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

/** Build Windows ToastGeneric XML: title (emoji+type) + body (#number title) + attribution line (repo) + circular avatar (optional). */
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

/** Fire a single notification: Windows rich style (avatar + emoji + repo), falling back to title/body text (with repo) on failure / other platforms. */
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
 * Fire system notifications per notification config. Master toggle off / platform does not support notifications → return directly (silent degrade). After filtering by type toggle:
 * fire at most the first {@link INDIVIDUAL_LIMIT} one by one (each with avatar rich style + click anchoring); the overflow (from the 6th on) is collapsed into one
 * "see more recent activity" prompt, whose click only opens the main UI without anchoring.
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
    authored_comment: cfg.authored_comment,
    authored_needs_work: cfg.authored_needs_work,
    authored_conflict: cfg.authored_conflict,
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
      // Overflow prompt: click goes to the default focusMainWindow (only opens the main UI, no anchoring), letting users browse more recent activity themselves.
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
 * Set the app badge count (macOS dock only this iteration). count≤0 clears the badge. The renderer has already derived the count per notification config; the main process only lands it.
 */
export function applyBadgeCount(count: number): void {
  if (process.platform !== 'darwin') return;
  app.setBadgeCount(Math.max(0, Math.floor(count)));
}
