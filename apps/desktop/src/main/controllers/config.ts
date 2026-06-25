import { writeConfig } from '@meebox/config';
import { buildDraftAdapter } from '../adapters.js';
import { setMainLanguage } from '../i18n/index.js';
import { getContext } from '../services/context.js';
import { testProxyConnectivity } from '../utils/proxy.js';
import type { IpcController } from './types.js';

/*
 * 配置操作域 controllers：读 / 写 config.yaml（含热生效与草稿暂存）及连接 / 代理试连
 */

/**
 * 读当前内存配置。
 */
export const readConfig: IpcController<'config:read'> = () => getContext().bootstrap.config;

/**
 * 写 repos_dir（重启生效）。
 */
export const setReposDir: IpcController<'config:setReposDir'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = {
    ...bootstrap.config,
    workspace: { ...bootstrap.config.workspace, repos_dir: req.reposDir },
  };
  await writeConfig(bootstrap.paths.configFile, next);
  logger.info({ reposDir: req.reposDir }, 'repos_dir updated; restart required');
};

/**
 * 写 UI 语言并即时生效：内存同步 + 主进程 i18n changeLanguage。
 */
export const setLanguage: IpcController<'config:setLanguage'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = { ...bootstrap.config, language: req.language };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.language = req.language;
  setMainLanguage(req.language);
  logger.info({ language: req.language }, 'language config updated');
};

/**
 * 写 GUI 主题偏好；内存同步。纯前端展示项，主进程无副作用（不切 i18n、不重建 adapter）。
 */
export const setTheme: IpcController<'config:setTheme'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const appearance = { ...bootstrap.config.appearance, theme: req.theme };
  await writeConfig(bootstrap.paths.configFile, { ...bootstrap.config, appearance });
  bootstrap.config.appearance = appearance;
  logger.info({ theme: req.theme }, 'theme preference updated');
};

/**
 * 写编辑器外观（Monaco 主题 + 等宽字体）；内存同步。纯前端展示项，主进程无副作用。
 */
export const setEditorAppearance: IpcController<'config:setEditorAppearance'> = async (
  _event,
  req,
) => {
  const { bootstrap, logger } = getContext();
  const appearance = {
    ...bootstrap.config.appearance,
    editor_theme: req.editor_theme,
    editor_font_family: req.editor_font_family,
    editor_font_size: req.editor_font_size,
  };
  await writeConfig(bootstrap.paths.configFile, { ...bootstrap.config, appearance });
  bootstrap.config.appearance = appearance;
  logger.info(
    {
      editorTheme: req.editor_theme,
      editorFontFamily: req.editor_font_family,
      editorFontSize: req.editor_font_size,
    },
    'editor appearance updated',
  );
};

/**
 * 写 LLM Provider 配置；内存同步，下次 pragent:run 用新值。
 */
export const setLlm: IpcController<'config:setLlm'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = { ...bootstrap.config, llm: req.llm };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.llm = req.llm;
  logger.info(
    { profileCount: req.llm.profiles.length, activeId: req.llm.active_id },
    'llm config updated',
  );
};

/**
 * 写 agent 配置（含 agent.dir）；内存同步，下次 pragent:run 现读生效。
 */
export const setAgent: IpcController<'config:setAgent'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = { ...bootstrap.config, agent: req.agent };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.agent = req.agent;
  logger.info({ agent: req.agent }, 'agent config updated');
};

/**
 * 翻转 AutoPilot 开关；关→开时立即 poll 一轮按准入规则评估。
 */
export const setAutopilotEnabled: IpcController<'agent:setAutopilotEnabled'> = async (
  _event,
  req,
) => {
  const { bootstrap, logger, poller } = getContext();
  const was = bootstrap.config.agent.autopilot.enabled;
  const agent = {
    ...bootstrap.config.agent,
    autopilot: { ...bootstrap.config.agent.autopilot, enabled: req.enabled },
  };
  await writeConfig(bootstrap.paths.configFile, { ...bootstrap.config, agent });
  bootstrap.config.agent = agent;
  logger.info({ enabled: req.enabled }, 'autopilot toggled');
  if (req.enabled && !was) {
    void poller.tick();
  }
};

/**
 * 写连接列表 + 启用连接，热重建 adapter/poller 并立即 poll 一轮。
 */
export const setConnections: IpcController<'config:setConnections'> = async (_event, req) => {
  const { bootstrap, logger, poller, reconfigureConnections } = getContext();
  const next = {
    ...bootstrap.config,
    connections: req.connections,
    active_connection_id: req.active_connection_id,
  };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.connections = req.connections;
  bootstrap.config.active_connection_id = req.active_connection_id;
  await reconfigureConnections();
  void poller.tick();
  logger.info(
    { count: req.connections.length, activeId: req.active_connection_id },
    'connections config updated (hot-reloaded)',
  );
};

/**
 * 写代理配置，热重建 adapter（REST 经代理即时生效）。
 */
export const setProxy: IpcController<'config:setProxy'> = async (_event, req) => {
  const { bootstrap, logger, reconfigureConnections } = getContext();
  const next = { ...bootstrap.config, proxy: req.proxy };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.proxy = req.proxy;
  await reconfigureConnections();
  logger.info(
    { enabled: req.proxy.enabled, host: req.proxy.host, port: req.proxy.port },
    'proxy config updated (hot-reloaded)',
  );
};

/**
 * 用给定代理试连，验证可用性；不写配置。
 */
export const testProxy: IpcController<'config:testProxy'> = (_event, req) =>
  testProxyConnectivity(req.proxy);

/**
 * 用草稿 url/token 临时起 adapter ping，不落配置；失败归一成 ok:false + reason。
 */
export const testConnection: IpcController<'config:testConnection'> = async (_event, req) => {
  try {
    return await buildDraftAdapter(
      req.base_url,
      req.token,
      getContext().bootstrap.config.proxy,
      req.kind,
    ).connection.ping();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * 配置过程中把连接 + LLM 草稿写盘防丢失，但不更新内存 config、不 reconfigure（不生效）。
 */
export const autosaveDraft: IpcController<'config:autosaveDraft'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = {
    ...bootstrap.config,
    connections: req.connections,
    active_connection_id: req.active_connection_id,
    llm: req.llm,
  };
  await writeConfig(bootstrap.paths.configFile, next);
  logger.info(
    { connections: req.connections.length, profiles: req.llm.profiles.length },
    'connections/llm draft autosaved to config.yaml (not applied)',
  );
};

/**
 * 写轮询间隔（clamp 60~900）并热替换 poller 定时器，无需重启。
 */
export const setPoller: IpcController<'config:setPoller'> = async (_event, req) => {
  const { bootstrap, logger, poller } = getContext();
  const seconds = Math.min(900, Math.max(60, Math.round(req.interval_seconds)));
  const next = {
    ...bootstrap.config,
    poller: { ...bootstrap.config.poller, interval_seconds: seconds },
  };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.poller.interval_seconds = seconds;
  poller.setIntervalSeconds(seconds);
  logger.info({ intervalSeconds: seconds }, 'poller interval updated (hot-reloaded)');
};
