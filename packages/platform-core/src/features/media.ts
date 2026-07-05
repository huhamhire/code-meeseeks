import type {
  CommentAttachmentResult,
  CommentAttachmentUpload,
  RepoRef,
} from '@meebox/shared';
import type { BinaryResource } from '../transport.js';
import { PlatformDomainService } from '../context.js';

/** User and media: avatar / comment inline attachment proxy (credentialed fetch gated by the platform trust model). */
export interface MediaService {
  /**
   * Fetch the user avatar image.
   *
   * Returns null when the platform does not support it or on failure; the caller falls back to initials.
   */
  getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;

  /**
   * Proxy-fetch an image embedded in a comment body.
   *
   * Returns null when the host does not belong to the current platform, the protocol cannot be parsed, or the fetch fails.
   */
  getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;

  /**
   * Upload an image as a comment attachment and return a markdown snippet insertable into the comment body.
   *
   * Only implemented by platforms whose `commentAttachments` capability is true (GitLab /uploads, Bitbucket attachments);
   * returns null on platforms that do not support it (GitHub has no public upload API).
   */
  uploadAttachment(
    repo: RepoRef,
    prId: string,
    file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null>;
}

/**
 * User and media domain base class: the avatar and attachment fetch contracts are left to platform subclasses to implement per their own asset domain.
 */
export abstract class BaseMediaService extends PlatformDomainService implements MediaService {
  /**
   * Implemented by platform subclasses: fetch the user avatar, returning null on failure or when unsupported.
   */
  abstract getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;

  /**
   * Implemented by platform subclasses: proxy-fetch a comment inline attachment, returning null when not this platform or on failure.
   */
  abstract getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;

  /**
   * Overridden by platform subclasses: upload a comment attachment and return markdown. Unsupported by default (returns null).
   */
  uploadAttachment(
    _repo: RepoRef,
    _prId: string,
    _file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null> {
    return Promise.resolve(null);
  }
}
