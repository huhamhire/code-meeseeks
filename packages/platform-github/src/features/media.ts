import type { RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';

/** GitHub 用户与媒体领域：头像与评论内嵌图片，经传输层带 PAT 拉可信资产域。 */
export class GitHubMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * 拉取用户头像：有 avatar_url 直链优先用之（兼容普通用户与机器人）；仅有 slug 时兜底拼 `<webBase>/<login>.png`。
   */
  async getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null> {
    // 有 avatar_url 直链优先用它：普通用户走 avatars.githubusercontent.com/u/<id>，
    // 机器人走 .../in/<app_id>——后者没有 <webBase>/<login>.png（login 含 [bot]）。
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    // 兜底（仅有 slug 时，如 ping 缓存的当前用户）：<webBase>/<login>.png?size=64
    return this.client.getBinary(`${this.client.webBase}/${encodeURIComponent(slug)}.png?size=64`);
  }

  /**
   * 代理拉取评论内嵌图片：内嵌图为绝对 URL，经 main 端带 PAT 拉取（私有需鉴权），失败返回 null 让上层回退。
   */
  async getAttachment(url: string, _repo?: RepoRef): Promise<BinaryResource | null> {
    // GitHub 评论内嵌图片是绝对 URL（user-attachments / githubusercontent / GHE host）；
    // 经 main 端带 PAT 代理拉（私有需鉴权）。非绝对 / 失败 → null 让上层 fallback。
    return this.client.getBinary(url);
  }
}
