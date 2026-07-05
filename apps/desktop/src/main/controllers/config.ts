import { randomBytes } from 'node:crypto';
import { nativeTheme } from 'electron';
import { editorThemeNativeSource } from '@meebox/shared';
import { writeConfig } from '@meebox/config';
import { buildDraftAdapter } from '../adapters.js';
import { setMainLanguage } from '../i18n/index.js';
import { getContext } from '../services/context.js';
import { testProxyConnectivity } from '../utils/proxy.js';
import type { IpcController } from './types.js';

/*
 * Config operation-domain controllers: read / write config.yaml (including hot-reload and draft staging) and connection / proxy test connections
 */

/**
 * Read the current in-memory config.
 */
export const readConfig: IpcController<'config:read'> = () => getContext().bootstrap.config;

/**
 * Write repos_dir (takes effect on restart).
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
 * Write the UI language and apply it immediately: in-memory sync + main-process i18n changeLanguage.
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
 * Write appearance (global theme = Monaco theme + monospace font + font size); in-memory sync. Theme switching is done instantly by the renderer; the main process sets
 * nativeTheme.themeSource from the theme so native window chrome (Windows thin border / window-control button light-dark) follows — the 'auto' theme
 * is handed back to the OS ('system'), the rest fixed light / dark. Window-control button colors are reset by WindowManager listening to nativeTheme 'updated'.
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
  nativeTheme.themeSource = editorThemeNativeSource(req.editor_theme);
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
 * Write LLM Provider config; in-memory sync, the next pragent:run uses the new values.
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
 * Write agent config (including agent.dir); in-memory sync means hot-reload — effectiveAgentDir now reads the in-memory config, and the next
 * context load uses the new directory (no resource binding, no rebuild needed). Template initialization for the new directory is not done here; it is guaranteed by lazy fill-in
 * (ensureAgentDir, see context.ts), to avoid binding initialization to this single settings-interaction path.
 */
export const setAgent: IpcController<'config:setAgent'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = { ...bootstrap.config, agent: req.agent };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.agent = req.agent;
  logger.info({ agent: req.agent }, 'agent config updated');
};

/**
 * Write message-notification config (master switch + per-type system notifications + dock badge); in-memory sync, the next poll popping notifications / renderer pushing the badge uses the new values.
 */
export const setNotifications: IpcController<'config:setNotifications'> = async (_event, req) => {
  const { bootstrap, logger } = getContext();
  const next = { ...bootstrap.config, notifications: req.notifications };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.notifications = req.notifications;
  logger.info({ notifications: req.notifications }, 'notifications config updated');
};

/**
 * Toggle the AutoPilot switch; on off→on, immediately run one poll to evaluate against the admission rules.
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
 * Write the connection list + active connection, hot-rebuild the adapter/poller and immediately run one poll.
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
 * Write proxy config, hot-rebuild the adapter (REST via proxy takes effect immediately).
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
 * Test-connect with the given proxy to verify usability; does not write config.
 */
export const testProxy: IpcController<'config:testProxy'> = (_event, req) =>
  testProxyConnectivity(req.proxy);

/**
 * Spin up a temporary adapter ping with draft url/token, without persisting config; failures normalize to ok:false + reason.
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
 * Write local API service listener config (switch / host / port / token); after in-memory sync, hot-rebuild the listener (stop old, start new).
 * The token is carried in the request body (the settings page saves the current value); the standalone "regenerate token" goes through generateServiceToken.
 */
export const setService: IpcController<'config:setService'> = async (_event, req) => {
  const { bootstrap, logger, reconfigureApiServer } = getContext();
  const next = { ...bootstrap.config, service: req.service };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.service = req.service;
  await reconfigureApiServer();
  logger.info(
    { enabled: req.service.enabled, host: req.service.host, port: req.service.port },
    'service listener config updated (hot-reloaded)',
  );
};

/**
 * Generate and return a high-strength random bearer token (32 bytes → base64url, 43 chars, charset [A-Za-z0-9-_], URL / header safe),
 * **without persisting** — the frontend places it into the settings draft and it takes effect via config:setService on the footer "Save"; discarded if not saved
 * (draft-based like host / port).
 */
export const generateServiceToken: IpcController<'config:generateServiceToken'> = () => {
  return { token: randomBytes(32).toString('base64url') };
};

/**
 * During configuration, write connection + LLM drafts to disk to avoid loss, but do not update the in-memory config and do not reconfigure (does not take effect).
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
 * Write the polling interval (clamp 60~900) and hot-swap the poller timer, no restart needed.
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

/**
 * Write the review-task concurrency (clamp 1~8) and hot-swap the run queue limit, no restart needed.
 */
export const setMaxConcurrency: IpcController<'config:setMaxConcurrency'> = async (_event, req) => {
  const { bootstrap, logger, runQueue } = getContext();
  const max = Math.min(8, Math.max(1, Math.round(req.max_concurrency)));
  const next = {
    ...bootstrap.config,
    pr_agent: { ...bootstrap.config.pr_agent, max_concurrency: max },
  };
  await writeConfig(bootstrap.paths.configFile, next);
  bootstrap.config.pr_agent.max_concurrency = max;
  runQueue.setMaxConcurrency(max);
  logger.info({ maxConcurrency: max }, 'pr-agent max_concurrency updated (hot-reloaded)');
};
