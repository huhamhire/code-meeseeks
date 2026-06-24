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
  /** 平台能力描述符（静态，按平台/版本/套餐固定）。聚合自各领域能力声明 + 连接探测细化。 */
  capabilities(): PlatformCapabilities;
  /** 连接探测：版本号 + 当前用户。版本低于硬下限时 ok=false 并给 reason。 */
  ping(): Promise<PingResult>;
  /** 返回 ping 期间缓存的当前 PAT 所属用户；未就绪返回 null（同步，仅读缓存）。 */
  getCurrentUser(): PlatformUser | null;
  /** 注入/恢复当前用户缓存（main 建连接时用本地持久化身份预热，ping 完成后被远端覆盖）。 */
  setCurrentUser?(user: PlatformUser | null): void;
  /** 返回 git clone URL（pat 内嵌 user:PAT / ssh scp-like）。 */
  getCloneUrl(repo: RepoRef): Promise<string>;
}

/** 连接领域基类：当前用户缓存读写为跨平台共享实现；ping / capabilities / clone 由平台子类实现。 */
export abstract class BaseConnection extends PlatformDomainService implements PlatformConnection {
  abstract readonly kind: PlatformKind;
  abstract capabilities(): PlatformCapabilities;
  abstract ping(): Promise<PingResult>;
  getCurrentUser(): PlatformUser | null {
    return this.ctx.getCurrentUser();
  }
  setCurrentUser(user: PlatformUser | null): void {
    this.ctx.setCurrentUser(user);
  }
  abstract getCloneUrl(repo: RepoRef): Promise<string>;
}
