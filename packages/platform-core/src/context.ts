import type { PlatformUser } from '@meebox/shared';
import type { PlatformTransport } from './transport.js';

/**
 * Connection context: the shared state of one platform connection, constructed once by the composer and injected into all domain services — the unified connection wrapper instance (transport) +
 * current-user cache. Ensures "one connection = one wrapper instance = one connection state", so no domain redundantly holds transport or token.
 */
export interface ConnectionContext {
  /** Platform connection transport (unified connection wrapper instance). */
  readonly transport: PlatformTransport;

  /**
   * Read the current PAT user cache (populated by ping or pre-warmed by setCurrentUser); returns null if not ready.
   */
  getCurrentUser(): PlatformUser | null;

  /**
   * Write the current PAT user cache, for each domain service to read synchronously.
   */
  setCurrentUser(user: PlatformUser | null): void;
}

/**
 * Default mutable connection-context implementation: caches the current user in one internal field, for the composer to construct once and inject into each domain service.
 */
export class MutableConnectionContext implements ConnectionContext {
  private user: PlatformUser | null = null;
  constructor(readonly transport: PlatformTransport) {}

  /**
   * Read the currently cached PAT user; returns null when not yet ready (not pinged / not pre-warmed).
   */
  getCurrentUser(): PlatformUser | null {
    return this.user;
  }

  /**
   * Write the current user cache, for subsequent synchronous reads (populated by ping or pre-warmed when the connection is established).
   */
  setCurrentUser(user: PlatformUser | null): void {
    this.user = user;
  }
}

/**
 * Domain-service base class: holds the shared connection context and exposes transport to subclasses.
 *
 * Each domain base class (connection / PR / comment / media) derives from this, ensuring each domain of the same connection shares one connection state.
 */
export abstract class PlatformDomainService {
  constructor(protected readonly ctx: ConnectionContext) {}

  /**
   * Return the platform connection transport (unified connection wrapper instance) held by the shared connection context, for subclasses to make requests.
   */
  protected get transport(): PlatformTransport {
    return this.ctx.transport;
  }
}
