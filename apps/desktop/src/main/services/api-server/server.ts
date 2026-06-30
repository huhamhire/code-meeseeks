import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BootstrapResult } from '@meebox/config';
import { ERROR_CODES } from '@meebox/shared';
import type { Logger } from 'pino';
import { HttpError, readJsonBody, sendError, sendOk } from './http.js';
import { matchRoute } from './routes.js';

/**
 * 本地 API 服务监听器（见 docs/arch/04-integration/01-service-api.md）。
 *
 * 主进程内置 HTTP listener，作为渲染层 IPC 之外的「第二前端」：复用同一 ControllerContext 与 service 层，
 * 把只读 PR / Agent 能力暴露给外部 CLI / 工具。默认关闭；开启即强制 bearer token 鉴权。生命周期由 main 装配：
 * start（按 config 决定是否 listen）/ stop（退出时优雅关闭）/ reconfigure（配置变更停旧起新）。
 */
export interface ApiServerDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
}

export class ApiServer {
  private server?: Server;

  constructor(private readonly deps: ApiServerDeps) {}

  /** 实时读内存 service 配置（token 变更无需重建即生效）。 */
  private get cfg() {
    return this.deps.bootstrap.config.service;
  }

  /** 按配置启动监听（未启用 / token 为空则不启动）。监听失败为非致命：记录后不抛，不拖垮应用启动。 */
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

  /** 优雅关闭：停止接收新连接、放行 in-flight 后落定。 */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.deps.logger.info('local API server stopped');
  }

  /** 配置（开关 / host / port）变更：停旧起新。 */
  async reconfigure(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** 常数时间比对 bearer token；缺 token 配置 / 非 Bearer 头 / 长度不符均判失败。 */
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
