import type { RepoRef } from '@meebox/shared';
import type { BinaryResource } from '../transport.js';
import { PlatformDomainService } from '../context.js';

/** 用户与媒体：头像 / 评论内嵌附件代理（带凭据拉取由平台信任模型把关）。 */
export interface MediaService {
  /** 拉用户头像图片。平台不支持或失败返回 null，调用方走 initials 回退。 */
  getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;
  /** 评论 body 内嵌图片代理。host 不属当前平台 / 协议无法解析 / 失败 → null。 */
  getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;
}

/** 用户与媒体领域基类。 */
export abstract class BaseMediaService extends PlatformDomainService implements MediaService {
  abstract getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;
  abstract getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;
}
