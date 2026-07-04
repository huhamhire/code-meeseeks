import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { PlatformAdapter } from '@meebox/platform-core';
import { sniffImageContentType } from '../utils/image.js';

// Same convention as app.ts avatar cache: directory <cacheDir>/avatars/, key is first 24 hex of sha256(connectionId|slug); raw bytes stored as .bin.
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface AvatarFileDeps {
  cacheDir: string;
  /** Get the adapter for the given connection (for fetching avatars); returns null if not found. */
  getAdapter: (connectionId: string) => PlatformAdapter | null;
  logger: Logger;
}

/**
 * Ensures the avatar for (connectionId, slug) is persisted to disk, and returns the absolute path of a local file **with the correct image extension**.
 *
 * Background: Windows toast's `<image src>` needs a local file and identifies the format by extension; but the avatar cache only stores raw bytes as `.bin`.
 * So besides the `.bin`, this attaches a `<hash>.<ext>` copy based on the sniffed content-type for the toast to reference. A hit that has not expired is reused,
 * a miss / expiry is fetched via the adapter and persisted. No adapter / fetch failure / non-bitmap (svg etc. not supported by toast) → returns null (caller falls back to no avatar).
 */
export async function ensureAvatarFile(
  deps: AvatarFileDeps,
  connectionId: string,
  slug: string,
  avatarUrl: string | undefined,
): Promise<string | null> {
  const avatarDir = path.join(deps.cacheDir, 'avatars');
  const hash = crypto
    .createHash('sha256')
    .update(`${connectionId}|${slug}`)
    .digest('hex')
    .slice(0, 24);
  const binPath = path.join(avatarDir, `${hash}.bin`);

  let bytes: Buffer | null = null;
  try {
    const stat = await fs.stat(binPath);
    if (Date.now() - stat.mtimeMs < AVATAR_TTL_MS) bytes = await fs.readFile(binPath);
  } catch {
    // .bin missing / read failed → go fetch
  }
  if (!bytes) {
    const adapter = deps.getAdapter(connectionId);
    if (!adapter) return null;
    try {
      const img = await adapter.media.getUserAvatar(slug, avatarUrl);
      if (!img) return null;
      bytes = Buffer.from(img.bytes);
      await fs.mkdir(avatarDir, { recursive: true });
      await fs.writeFile(binPath, bytes);
    } catch (err) {
      deps.logger.debug({ err, connectionId, slug }, 'notification avatar fetch failed');
      return null;
    }
  }

  const ext = EXT_BY_CONTENT_TYPE[sniffImageContentType(bytes)];
  if (!ext) return null; // svg / unknown format: unreliable for Windows toast, fall back to no avatar
  const imgPath = path.join(avatarDir, `${hash}.${ext}`);
  try {
    let needWrite = true;
    try {
      const [binStat, imgStat] = await Promise.all([fs.stat(binPath), fs.stat(imgPath)]);
      needWrite = imgStat.mtimeMs < binStat.mtimeMs; // copy older than raw bytes → rewrite
    } catch {
      needWrite = true; // copy does not exist
    }
    if (needWrite) await fs.writeFile(imgPath, bytes);
    return imgPath;
  } catch (err) {
    deps.logger.debug({ err, hash }, 'notification avatar ext-copy write failed');
    return null;
  }
}
