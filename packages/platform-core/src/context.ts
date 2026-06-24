import type { PlatformUser } from '@meebox/shared';
import type { PlatformTransport } from './transport.js';

/**
 * 连接上下文：一个平台连接的共享态，由组合器一次构造、注入全部领域服务——统一连接封装实例（传输）+
 * 当前用户缓存。确保「一个连接 = 一个封装实例 = 一份连接态」，各领域不重复持有 transport 或 token。
 */
export interface ConnectionContext {
  /** 平台连接传输（统一连接封装实例）。 */
  readonly transport: PlatformTransport;
  /**
   * 读取当前 PAT 用户缓存（由 ping 落地或 setCurrentUser 预热）；未就绪返回 null。
   */
  getCurrentUser(): PlatformUser | null;
  /**
   * 写入当前 PAT 用户缓存，供各领域服务同步读取。
   */
  setCurrentUser(user: PlatformUser | null): void;
}

/**
 * 默认可变连接上下文实现：以一个内部字段缓存当前用户，供组合器一次构造后注入各领域服务。
 */
export class MutableConnectionContext implements ConnectionContext {
  private user: PlatformUser | null = null;
  constructor(readonly transport: PlatformTransport) {}
  /**
   * 读取当前缓存的 PAT 用户；尚未就绪（未 ping / 未预热）时返回 null。
   */
  getCurrentUser(): PlatformUser | null {
    return this.user;
  }
  /**
   * 写入当前用户缓存，供后续同步读取（ping 落地或建连接时预热）。
   */
  setCurrentUser(user: PlatformUser | null): void {
    this.user = user;
  }
}

/**
 * 领域服务基类：持有共享连接上下文，向子类暴露 transport。
 *
 * 各领域基类（连接 / PR / 评论 / 媒体）由此派生，确保同一连接的各领域共享一份连接态。
 */
export abstract class PlatformDomainService {
  constructor(protected readonly ctx: ConnectionContext) {}
  /**
   * 返回共享连接上下文持有的平台连接传输（统一连接封装实例），供子类发请求。
   */
  protected get transport(): PlatformTransport {
    return this.ctx.transport;
  }
}
