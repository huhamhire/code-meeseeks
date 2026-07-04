import type { CommentAttachmentResult, CommentAttachmentUpload, RepoRef } from '@meebox/shared';
import {
  BaseMediaService,
  type BinaryResource,
  type ConnectionContext,
} from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import type { BitbucketAttachmentUploadResponse } from '../types.js';

/** Bitbucket user and media domain: avatars (avatar.png path endpoint) and comment inline attachments (attachment protocol parsing). */
export class BitbucketMediaService extends BaseMediaService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * Fetch a user avatar (`/users/{slug}/avatar.png?s=64`).
   *
   * A Bitbucket user slug is always lowercase, but the author in comments / activities often carries back a
   * mixed-case name without a slug field; when the caller falls back to name, a case mismatch yields 404 —
   * try the original value first, then lowercase once on failure. Returns null if all fail.
   */
  async getUserAvatar(slug: string, _avatarUrl?: string): Promise<BinaryResource | null> {
    const candidates = slug !== slug.toLowerCase() ? [slug, slug.toLowerCase()] : [slug];
    for (const s of candidates) {
      try {
        return await this.client.getBinary(`/users/${encodeURIComponent(s)}/avatar.png`, {
          s: '64',
        });
      } catch {
        // Try the next candidate
      }
    }
    return null;
  }

  /**
   * Proxy-fetch a comment inline attachment.
   *
   * Host resolution, Bitbucket `attachment:` protocol handling, and PAT-authenticated fetching are all done inside the client; this method is only a thin wrapper.
   */
  async getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null> {
    return this.client.getAttachmentBinary(url, repo);
  }

  /**
   * Upload an image to the repository attachments endpoint (multipart field `files`), returning markdown embeddable in a comment.
   * Prefer the response `links.attachment.href` (shaped like `attachment:<repoId>/<id>`, which getAttachmentBinary renders from),
   * falling back to `attachment:<id>`. Attachments are repository-level, not PR-level, so prId is ignored.
   *
   * The endpoint is a **private servlet** at `/projects/{key}/repos/{slug}/attachments` (**without** the `/rest/api/1.0`
   * prefix — with the prefix it returns 405; in practice this bare path has Allow: POST). Download still goes through `/rest/api/1.0/.../attachments/{id}`.
   */
  override async uploadAttachment(
    repo: RepoRef,
    _prId: string,
    file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null> {
    const form = new FormData();
    form.append(
      'files',
      new Blob([file.bytes as BlobPart], { type: file.contentType }),
      file.fileName,
    );
    const res = await this.client.postForm<BitbucketAttachmentUploadResponse>(
      `/projects/${repo.projectKey}/repos/${repo.repoSlug}/attachments`,
      form,
    );
    const a = res.attachments?.[0];
    if (!a) return null;
    const href = a.links?.attachment?.href ?? (a.id != null ? `attachment:${String(a.id)}` : null);
    if (!href) return null;
    return { markdown: `![${file.fileName}](${href})` };
  }
}
