import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BootstrapResult } from '@meebox/config';
import { ERROR_CODES } from '@meebox/shared';
import type { Logger } from 'pino';
import { CLI_VERSION_HEADER, MIN_CLI_VERSION, isClientTooOld } from './compat.js';
import { HttpError, readJsonBody, sendError, sendOk } from './http.js';
import { matchRoute } from './routes/index.js';

/**
 * Local API service listener (see docs/arch/04-integration/01-service-api.md).
 *
 * A built-in HTTP listener in the main process, acting as a "second frontend" beyond the renderer IPC: it reuses the same
 * ControllerContext and service layer to expose read-only PR / Agent capabilities to external CLI / tools. Off by default;
 * enabling it enforces bearer token auth. Lifecycle wired up by main:
 * start (decides whether to listen per config) / stop (graceful close on exit) / reconfigure (stop old, start new on config change).
 */
export interface ApiServerDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
}

export class ApiServer {
  private server?: Server;

  constructor(private readonly deps: ApiServerDeps) {}

  /** Read the in-memory service config live (token changes take effect without rebuild). */
  private get cfg() {
    return this.deps.bootstrap.config.service;
  }

  /** Start listening per config (skip if disabled / token empty). Listen failure is non-fatal: log and don't throw, so it won't drag down app startup. */
  async start(): Promise<void> {
    if (this.server) return;
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    if (!cfg.token) {
      this.deps.logger.warn('api server enabled but token is empty; not starting');
      return;
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server = undefined;
        reject(err);
      };
      server.once('error', onError);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', onError);
        server.on('error', (err) => this.deps.logger.error({ err }, 'api server runtime error'));
        this.deps.logger.info({ host: cfg.host, port: cfg.port }, 'local API server listening');
        resolve();
      });
    }).catch((err: unknown) => {
      this.deps.logger.error({ err, port: cfg.port }, 'local API server failed to listen (non-fatal)');
    });
  }

  /** Graceful close: stop accepting new connections, let in-flight requests drain, then settle. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.deps.logger.info('local API server stopped');
  }

  /** Config (toggle / host / port) change: stop old, start new. */
  async reconfigure(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Constant-time compare of the bearer token; missing token config / non-Bearer header / length mismatch all fail. */
  private authorized(req: IncomingMessage): boolean {
    const token = this.cfg.token;
    if (!token) return false;
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(token);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const search = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';

    let outcome: { status: number; code?: string };
    try {
      if (!this.authorized(req)) throw new HttpError(401, ERROR_CODES.SV_UNAUTHORIZED);
      // Compatibility gate: uniformly reject too-old CLIs on all API calls (missing version header / unparseable → let through).
      if (isClientTooOld(req.headers[CLI_VERSION_HEADER])) {
        throw new HttpError(426, ERROR_CODES.SV_CLIENT_TOO_OLD, {
          minVersion: MIN_CLI_VERSION,
          clientVersion: String(req.headers[CLI_VERSION_HEADER] ?? ''),
        });
      }
      const matched = matchRoute(method, pathname);
      if (!matched) throw new HttpError(404, ERROR_CODES.SV_NOT_FOUND);
      const body = method === 'POST' ? await readJsonBody(req) : undefined;
      const data = await matched.route.handler({
        params: matched.params,
        query: new URLSearchParams(search),
        body,
      });
      sendOk(res, data);
      outcome = { status: 200 };
    } catch (err) {
      outcome = sendError(res, err);
    }
    this.deps.logger.debug(
      { method, path: pathname, status: outcome.status, code: outcome.code, ms: Date.now() - started },
      'api request',
    );
  }
}
