import { writeConfig } from '@meebox/config';
import { buildDraftAdapter } from '../adapters.js';
import { setMainLanguage } from '../i18n/index.js';
import { testProxyConnectivity } from '../utils/proxy.js';
import type { IpcController } from './register.js';

// ── 配置操作域 controllers：读 / 写 config.yaml（含热生效与草稿暂存）及连接 / 代理试连 ──

export const readConfig: IpcController<'config:read'> = (ctx) => ctx.bootstrap.config;

// 写 repos_dir（重启生效）。
export const setReposDir: IpcController<'config:setReposDir'> = async (ctx, req) => {
  const next = {
    ...ctx.bootstrap.config,
    workspace: { ...ctx.bootstrap.config.workspace, repos_dir: req.reposDir },
  };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.logger.info({ reposDir: req.reposDir }, 'repos_dir updated; restart required');
};

// 写 UI 语言并即时生效：内存同步 + 主进程 i18n changeLanguage。
export const setLanguage: IpcController<'config:setLanguage'> = async (ctx, req) => {
  const next = { ...ctx.bootstrap.config, language: req.language };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.language = req.language;
  setMainLanguage(req.language);
  ctx.logger.info({ language: req.language }, 'language config updated');
};

// 写 LLM Provider 配置；内存同步，下次 pragent:run 用新值。
export const setLlm: IpcController<'config:setLlm'> = async (ctx, req) => {
  const next = { ...ctx.bootstrap.config, llm: req.llm };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.llm = req.llm;
  ctx.logger.info(
    { profileCount: req.llm.profiles.length, activeId: req.llm.active_id },
    'llm config updated',
  );
};

// 写 agent 配置（含 agent.dir）；内存同步，下次 pragent:run 现读生效。
export const setAgent: IpcController<'config:setAgent'> = async (ctx, req) => {
  const next = { ...ctx.bootstrap.config, agent: req.agent };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.agent = req.agent;
  ctx.logger.info({ agent: req.agent }, 'agent config updated');
};

// 翻转 AutoPilot 开关；关→开时立即 poll 一轮按准入规则评估。
export const setAutopilotEnabled: IpcController<'agent:setAutopilotEnabled'> = async (ctx, req) => {
  const was = ctx.bootstrap.config.agent.autopilot.enabled;
  const agent = {
    ...ctx.bootstrap.config.agent,
    autopilot: { ...ctx.bootstrap.config.agent.autopilot, enabled: req.enabled },
  };
  await writeConfig(ctx.bootstrap.paths.configFile, { ...ctx.bootstrap.config, agent });
  ctx.bootstrap.config.agent = agent;
  ctx.logger.info({ enabled: req.enabled }, 'autopilot toggled');
  if (req.enabled && !was) {
    void ctx.poller.tick();
  }
};

// 写连接列表 + 启用连接，热重建 adapter/poller 并立即 poll 一轮。
export const setConnections: IpcController<'config:setConnections'> = async (ctx, req) => {
  const next = {
    ...ctx.bootstrap.config,
    connections: req.connections,
    active_connection_id: req.active_connection_id,
  };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.connections = req.connections;
  ctx.bootstrap.config.active_connection_id = req.active_connection_id;
  await ctx.reconfigureConnections();
  void ctx.poller.tick();
  ctx.logger.info(
    { count: req.connections.length, activeId: req.active_connection_id },
    'connections config updated (hot-reloaded)',
  );
};

// 写代理配置，热重建 adapter（REST 经代理即时生效）。
export const setProxy: IpcController<'config:setProxy'> = async (ctx, req) => {
  const next = { ...ctx.bootstrap.config, proxy: req.proxy };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.proxy = req.proxy;
  await ctx.reconfigureConnections();
  ctx.logger.info(
    { enabled: req.proxy.enabled, host: req.proxy.host, port: req.proxy.port },
    'proxy config updated (hot-reloaded)',
  );
};

// 用给定代理试连，验证可用性；不写配置。
export const testProxy: IpcController<'config:testProxy'> = (_ctx, req) =>
  testProxyConnectivity(req.proxy);

// 用草稿 url/token 临时起 adapter ping，不落配置；失败归一成 ok:false + reason。
export const testConnection: IpcController<'config:testConnection'> = async (ctx, req) => {
  try {
    return await buildDraftAdapter(
      req.base_url,
      req.token,
      ctx.bootstrap.config.proxy,
      req.kind,
    ).ping();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
};

// 配置过程中把连接 + LLM 草稿写盘防丢失，但不更新内存 config、不 reconfigure（不生效）。
export const autosaveDraft: IpcController<'config:autosaveDraft'> = async (ctx, req) => {
  const next = {
    ...ctx.bootstrap.config,
    connections: req.connections,
    active_connection_id: req.active_connection_id,
    llm: req.llm,
  };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.logger.info(
    { connections: req.connections.length, profiles: req.llm.profiles.length },
    'connections/llm draft autosaved to config.yaml (not applied)',
  );
};

// 写轮询间隔（clamp 60~900）并热替换 poller 定时器，无需重启。
export const setPoller: IpcController<'config:setPoller'> = async (ctx, req) => {
  const seconds = Math.min(900, Math.max(60, Math.round(req.interval_seconds)));
  const next = {
    ...ctx.bootstrap.config,
    poller: { ...ctx.bootstrap.config.poller, interval_seconds: seconds },
  };
  await writeConfig(ctx.bootstrap.paths.configFile, next);
  ctx.bootstrap.config.poller.interval_seconds = seconds;
  ctx.poller.setIntervalSeconds(seconds);
  ctx.logger.info({ intervalSeconds: seconds }, 'poller interval updated (hot-reloaded)');
};
