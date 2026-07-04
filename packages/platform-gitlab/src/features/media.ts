import type { CommentAttachmentResult, CommentAttachmentUpload, RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { projectId } from '../utils.js';

/** GitLab user and media domain: avatar (avatar_url direct link) and project upload attachments (via the API download endpoint). */
export class GitLabMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * Fetch a user avatar: GitLab has no username-based direct-link form, so only fetch when avatar_url is given, otherwise return null to fall back to initials.
   */
  async getUserAvatar(_slug: string, avatarUrl?: string): Promise<BinaryResource | null> {
    // GitLab has no <host>/<username>.png direct link; only fetch when there's an avatar_url direct link (only this instance's host carries the PAT),
    // otherwise fall back to initials.
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    return null;
  }

  /**
   * Proxy-fetch a comment's embedded attachment.
   *
   * This instance's `/uploads/<secret>/<file>` is rerouted through the PAT-carrying API download endpoint (web routes always 302 a PAT to the login page);
   * other absolute URLs on this instance are proxied directly; non-this-instance / unparseable returns null to let the caller fall back.
   */
  async getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null> {
    // Project markdown uploads `/uploads/<secret>/<file>` (absolute or relative): their web routes always 302
    // a PAT to the login page (private projects only accept a browser session), so reroute through the API download endpoint `GET /projects/:id/uploads/
    // :secret/:filename` (GitLab 17.4+ accepts PRIVATE-TOKEN; old versions lack this route → 404 → null).
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
    // Other absolute URLs on this instance (images that aren't /uploads) are still proxied directly; non-this-instance / unparseable → null to let the caller fall back.
    if (/^https?:\/\//.test(url)) return this.client.getBinary(url);
    return null;
  }

  /**
   * Upload an image to the project `/uploads` (project-level, not PR-level, prId ignored), returning the markdown GitLab provides
   * (`![file](/uploads/<secret>/<file>)`). That relative URL is rendered via getAttachment through the API download endpoint.
   */
  override async uploadAttachment(
    repo: RepoRef,
    _prId: string,
    file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([file.bytes as BlobPart], { type: file.contentType }),
      file.fileName,
    );
    const res = await this.client.postForm<{ markdown?: string; url?: string }>(
      `/projects/${projectId(repo)}/uploads`,
      form,
    );
    if (res.markdown) return { markdown: res.markdown };
    if (res.url) return { markdown: `![${file.fileName}](${res.url})` };
    return null;
  }
}
