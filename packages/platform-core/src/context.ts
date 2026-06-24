import type { PlatformUser } from '@meebox/shared';
import type { PlatformTransport } from './transport.js';

/**
 * 连接上下文：一个平台连接的共享态，由组合器一次构造、注入全部领域服务——统一连接封装实例（传输）+
 * 当前用户缓存。确保「一个连接 = 一个封装实例 = 一份连接态」，各领域不重复持有 transport 或 token。
 */
export interface ConnectionContext {
  /** 平台连接传输（统一连接封装实例）。 */
  readonly transport: PlatformTransport;
  /** 当前 PAT 用户缓存（ping 落地 / setCurrentUser 预热）。 */
  getCurrentUser(): PlatformUser | null;
  setCurrentUser(user: PlatformUser | null): void;
}

/** 默认可变连接上下文实现。 */
export class MutableConnectionContext implements ConnectionContext {
  private user: PlatformUser | null = null;
  constructor(readonly transport: PlatformTransport) {}
  getCurrentUser(): PlatformUser | null {
    return this.user;
  }
  setCurrentUser(user: PlatformUser | null): void {
    this.user = user;
  }
}

/** 领域服务基类：持有共享连接上下文，向子类暴露 transport。各领域基类由此派生。 */
export abstract class PlatformDomainService {
  constructor(protected readonly ctx: ConnectionContext) {}
  protected get transport(): PlatformTransport {
    return this.ctx.transport;
  }
}
