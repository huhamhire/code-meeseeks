import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { PlatformAdapter } from '@meebox/platform-core';
import { sniffImageContentType } from '../utils/image.js';

// 与 app.ts 头像缓存同约定：目录 <cacheDir>/avatars/，键 sha256(connectionId|slug) 前 24 hex；原始字节存 .bin。
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface AvatarFileDeps {
  cacheDir: string;
  /** 取指定连接的 adapter（拉头像用）；找不到回 null。 */
  getAdapter: (connectionId: string) => PlatformAdapter | null;
  logger: Logger;
}

/**
 * 确保 (connectionId, slug) 的头像已落盘，并返回一个**带正确图片扩展名**的本地文件绝对路径。
 *
 * 背景：Windows toast 的 `<image src>` 需要本地文件且按扩展名识别格式；而头像缓存只存裸字节 `.bin`。
 * 故此处在 `.bin` 之外按嗅探到的 content-type 旁挂一份 `<hash>.<ext>` 供 toast 引用。命中且未过期的缓存复用，
 * 缺失 / 过期经 adapter 拉取并落盘。无 adapter / 拉取失败 / 非位图（svg 等 toast 不支持）→ 返回 null（调用方降级为无头像）。
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
    // .bin 不存在 / 读失败 → 走拉取
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
  if (!ext) return null; // svg / 未知格式：Windows toast 不可靠，降级无头像
  const imgPath = path.join(avatarDir, `${hash}.${ext}`);
  try {
    let needWrite = true;
    try {
      const [binStat, imgStat] = await Promise.all([fs.stat(binPath), fs.stat(imgPath)]);
      needWrite = imgStat.mtimeMs < binStat.mtimeMs; // 副本比原始字节旧 → 重写
    } catch {
      needWrite = true; // 副本不存在
    }
    if (needWrite) await fs.writeFile(imgPath, bytes);
    return imgPath;
  } catch (err) {
    deps.logger.debug({ err, hash }, 'notification avatar ext-copy write failed');
    return null;
  }
}
