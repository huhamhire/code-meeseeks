import type { RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { projectId } from '../utils.js';

/** GitLab 用户与媒体领域：头像（avatar_url 直链）与项目上传附件（走 API 下载端点）。 */
export class GitLabMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  async getUserAvatar(_slug: string, avatarUrl?: string): Promise<BinaryResource | null> {
    // GitLab 无 <host>/<username>.png 直链；只有 avatar_url 直链时才拉（本实例 host 才带 PAT），
    // 否则退 initials。
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    return null;
  }

  async getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null> {
    // 项目 markdown 上传 `/uploads/<secret>/<file>`（绝对或相对皆可）：其 web 路由对 PAT 一律 302
    // 到登录页（私有项目仅认浏览器 session），故改走 API 下载端点 `GET /projects/:id/uploads/
    // :secret/:filename`（GitLab 17.4+ 认 PRIVATE-TOKEN；旧版无此路由 → 404 → null）。
    const isRelative = !/^https?:\/\//.test(url);
    let sameHost = isRelative;
    if (!isRelative) {
      try {
        sameHost = new URL(url).host === this.client.gitHost;
      } catch {
        sameHost = false;
      }
    }
    const m = url.match(/\/uploads\/([0-9a-f]+)\/([^/?#]+)/i);
    if (m && repo && sameHost) {
      const [, secret, filename] = m;
      return this.client.getApiBinary(`/projects/${projectId(repo)}/uploads/${secret}/${filename}`);
    }
    // 其它本实例绝对 URL（非 /uploads 的图）仍直接代理；非本实例 / 解析不出 → null 让上层 fallback。
    if (/^https?:\/\//.test(url)) return this.client.getBinary(url);
    return null;
  }
}
