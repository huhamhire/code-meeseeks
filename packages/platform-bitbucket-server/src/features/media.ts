import type { RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';

/** Bitbucket 用户与媒体领域：头像（avatar.png 路径端点）与评论内嵌附件（attachment 协议解析）。 */
export class BitbucketMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * 拉用户头像（`/users/{slug}/avatar.png?s=64`）。
   *
   * Bitbucket user slug 总是小写，但 comments / activities 的 author 常带回大小写混合的 name 且不附
   * slug 字段；调用方退回 name 时大小写不一致会 404 —— 先按原值试，失败再小写一次。全部失败返回 null。
   */
  async getUserAvatar(slug: string, _avatarUrl?: string): Promise<BinaryResource | null> {
    const candidates = slug !== slug.toLowerCase() ? [slug, slug.toLowerCase()] : [slug];
    for (const s of candidates) {
      try {
        return await this.client.getBinary(`/users/${encodeURIComponent(s)}/avatar.png`, {
          s: '64',
        });
      } catch {
        // 试下一个候选
      }
    }
    return null;
  }

  /**
   * 代理拉取评论内嵌附件。
   *
   * host 解析、Bitbucket `attachment:` 协议处理与 PAT 鉴权拉取均在 client 内完成，本方法仅薄封装。
   */
  async getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null> {
    return this.client.getAttachmentBinary(url, repo);
  }
}
