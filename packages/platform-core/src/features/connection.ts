import type {
  PingResult,
  PlatformCapabilities,
  PlatformKind,
  PlatformUser,
  RepoRef,
} from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** 连接 / 身份 / 克隆（根领域）：连接探测、当前用户缓存、能力聚合入口、git 克隆 URL。 */
export interface PlatformConnection {
  readonly kind: PlatformKind;
  /**
   * 平台能力描述符（静态，按平台/版本/套餐固定）。
   *
   * 聚合自各领域能力声明，并由连接探测结果细化。
   */
  capabilities(): PlatformCapabilities;
  /**
   * 连接探测：返回服务端版本号与当前用户。
   *
   * 版本低于硬下限时 ok=false 并给出 reason。
   */
  ping(): Promise<PingResult>;
  /**
   * 返回 ping 期间缓存的当前 PAT 所属用户；未就绪返回 null。
   *
   * 同步方法，仅读缓存、不发请求。
   */
  getCurrentUser(): PlatformUser | null;
  /**
   * 注入 / 恢复当前用户缓存。
   *
   * main 建连接时用本地持久化身份预热，ping 完成后被远端结果覆盖。
   */
  setCurrentUser?(user: PlatformUser | null): void;
  /**
   * 返回 git clone URL（PAT 内嵌 user:PAT 或 ssh scp-like 形式）。
   */
  getCloneUrl(repo: RepoRef): Promise<string>;
}

/**
 * 连接领域基类：当前用户缓存读写为跨平台共享实现；ping / capabilities / clone 由平台子类实现。
 */
export abstract class BaseConnection extends PlatformDomainService implements PlatformConnection {
  abstract readonly kind: PlatformKind;
  /**
   * 由平台子类声明本平台的能力描述符（审批模型、行内评论、合并否决保真度等）。
   */
  abstract capabilities(): PlatformCapabilities;
  /**
   * 由平台子类实现连接探测：取服务端版本与当前用户，并落地用户缓存。
   */
  abstract ping(): Promise<PingResult>;
  /**
   * 读取共享上下文缓存的当前用户；未就绪返回 null。
   */
  getCurrentUser(): PlatformUser | null {
    return this.ctx.getCurrentUser();
  }
  /**
   * 写入共享上下文的当前用户缓存。
   */
  setCurrentUser(user: PlatformUser | null): void {
    this.ctx.setCurrentUser(user);
  }
  /**
   * 由平台子类实现：按仓库引用构造可直接克隆的 git URL。
   */
  abstract getCloneUrl(repo: RepoRef): Promise<string>;
}
