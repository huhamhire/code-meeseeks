import type { RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';

/** GitHub user and media domain: avatars and comment inline images, fetched from trusted asset hosts with the PAT via the transport layer. */
export class GitHubMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * Fetch the user avatar: prefer the direct avatar_url link when present (works for regular users and bots); fall back to `<webBase>/<login>.png` when only slug is available.
   */
  async getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null> {
    // Prefer the direct avatar_url link when present: regular users go through avatars.githubusercontent.com/u/<id>,
    // bots go through .../in/<app_id> — the latter has no <webBase>/<login>.png (login contains [bot]).
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    // Fallback (when only slug is available, e.g. the current user cached by ping): <webBase>/<login>.png?size=64
    return this.client.getBinary(`${this.client.webBase}/${encodeURIComponent(slug)}.png?size=64`);
  }

  /**
   * Proxy-fetch a comment inline image: the inline image is an absolute URL, fetched with the PAT on the main side (private needs auth), returns null on failure to let the upper layer fall back.
   */
  async getAttachment(url: string, _repo?: RepoRef): Promise<BinaryResource | null> {
    // GitHub comment inline images are absolute URLs (user-attachments / githubusercontent / GHE host);
    // proxy-fetched with the PAT on the main side (private needs auth). Non-absolute / failure → null to let the upper layer fall back.
    return this.client.getBinary(url);
  }
}
