import type {
  CommentAttachmentResult,
  CommentAttachmentUpload,
  RepoRef,
} from '@meebox/shared';
import type { BinaryResource } from '../transport.js';
import { PlatformDomainService } from '../context.js';

/** 用户与媒体：头像 / 评论内嵌附件代理（带凭据拉取由平台信任模型把关）。 */
export interface MediaService {
  /**
   * 拉取用户头像图片。
   *
   * 平台不支持或失败返回 null，调用方走 initials 回退。
   */
  getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;

  /**
   * 代理拉取评论 body 内嵌图片。
   *
   * host 不属当前平台、协议无法解析或拉取失败时返回 null。
   */
  getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;

  /**
   * 上传一张图片作为评论附件，返回可插入评论正文的 markdown 片段。
   *
   * 仅 `commentAttachments` 能力为真的平台实现（GitLab /uploads、Bitbucket attachments）；
   * 不支持的平台返回 null（GitHub 无公开上传 API）。
   */
  uploadAttachment(
    repo: RepoRef,
    prId: string,
    file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null>;
}

/**
 * 用户与媒体领域基类：头像与附件拉取契约留给平台子类按各自资产域实现。
 */
export abstract class BaseMediaService extends PlatformDomainService implements MediaService {
  /**
   * 由平台子类实现：拉取用户头像，失败或不支持返回 null。
   */
  abstract getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;

  /**
   * 由平台子类实现：代理拉取评论内嵌附件，非本平台或失败返回 null。
   */
  abstract getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;

  /**
   * 由平台子类覆写：上传评论附件并回 markdown。默认不支持（返回 null）。
   */
  uploadAttachment(
    _repo: RepoRef,
    _prId: string,
    _file: CommentAttachmentUpload,
  ): Promise<CommentAttachmentResult | null> {
    return Promise.resolve(null);
  }
}
