import { ipcMain } from 'electron';
import { writeConfig } from '@meebox/config';
import type { IpcChannels } from '@meebox/ipc';
import { buildDraftAdapter } from '../../adapters.js';
import { setMainLanguage } from '../../i18n/index.js';
import { testProxyConnectivity } from '../../utils/proxy.js';
import type { IpcContext } from '../context.js';

/** 配置操作域：读 / 写 config.yaml（含热生效与草稿暂存）及连接 / 代理试连。 */
export function registerConfigHandlers(ctx: IpcContext): void {
  const { bootstrap, logger, poller, reconfigureConnections } = ctx;

  ipcMain.handle('config:read', (): IpcChannels['config:read']['response'] => bootstrap.config);

  ipcMain.handle(
    'config:setReposDir',
    async (_evt, req: IpcChannels['config:setReposDir']['request']): Promise<void> => {
      const next = {
        ...bootstrap.config,
        workspace: {
          ...bootstrap.config.workspace,
          repos_dir: req.reposDir,
        },
      };
      await writeConfig(bootstrap.paths.configFile, next);
      logger.info({ reposDir: req.reposDir }, 'repos_dir updated; restart required');
    },
  );

  ipcMain.handle(
    'config:setLanguage',
    async (_evt, req: IpcChannels['config:setLanguage']['request']): Promise<void> => {
      const next = { ...bootstrap.config, language: req.language };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存同步 + 主进程 i18n 即时切换（新 dialog/错误文案与下次 pragent:run 的响应语言随之）。
      bootstrap.config.language = req.language;
      setMainLanguage(req.language);
      logger.info({ language: req.language }, 'language config updated');
    },
  );

  ipcMain.handle(
    'config:setLlm',
    async (_evt, req: IpcChannels['config:setLlm']['request']): Promise<void> => {
      const next = { ...bootstrap.config, llm: req.llm };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存中 config 同步更新，下一次 pragent:run 立刻用新值（不等重启）
      bootstrap.config.llm = req.llm;
      logger.info(
        {
          profileCount: req.llm.profiles.length,
          activeId: req.llm.active_id,
        },
        'llm config updated',
      );
    },
  );

  ipcMain.handle(
    'config:setAgent',
    async (_evt, req: IpcChannels['config:setAgent']['request']): Promise<void> => {
      const next = { ...bootstrap.config, agent: req.agent };
      await writeConfig(bootstrap.paths.configFile, next);
      bootstrap.config.agent = req.agent;
      logger.info({ agent: req.agent }, 'agent config updated');
    },
  );

  ipcMain.handle(
    'agent:setAutopilotEnabled',
    async (_evt, req: IpcChannels['agent:setAutopilotEnabled']['request']): Promise<void> => {
      const was = bootstrap.config.agent.autopilot.enabled;
      const agent = {
        ...bootstrap.config.agent,
        autopilot: { ...bootstrap.config.agent.autopilot, enabled: req.enabled },
      };
      await writeConfig(bootstrap.paths.configFile, { ...bootstrap.config, agent });
      bootstrap.config.agent = agent;
      logger.info({ enabled: req.enabled }, 'autopilot toggled');
      // 关 → 开：立即触发一次 poll（刷新 PR 列表 / 状态），其 onTick 即按准入规则评估并按需开评审，
      // 不必等下个轮询周期。
      if (req.enabled && !was) {
        void poller.tick();
      }
    },
  );

  ipcMain.handle(
    'config:setConnections',
    async (_evt, req: IpcChannels['config:setConnections']['request']): Promise<void> => {
      const next = {
        ...bootstrap.config,
        connections: req.connections,
        active_connection_id: req.active_connection_id,
      };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存 config 同步 + 热重建 adapter/poller，连接变更即时生效（不等重启）
      bootstrap.config.connections = req.connections;
      bootstrap.config.active_connection_id = req.active_connection_id;
      await reconfigureConnections();
      // 立刻 poll 一轮，让启用 / 切换的连接 PR 马上出现（active 为空则空操作）
      void poller.tick();
      logger.info(
        { count: req.connections.length, activeId: req.active_connection_id },
        'connections config updated (hot-reloaded)',
      );
    },
  );

  ipcMain.handle(
    'config:setProxy',
    async (_evt, req: IpcChannels['config:setProxy']['request']): Promise<void> => {
      const next = { ...bootstrap.config, proxy: req.proxy };
      await writeConfig(bootstrap.paths.configFile, next);
      // 内存同步 + 热重建 adapter（REST fetch 用上新代理）；git/pr-agent 出口读最新配置无需重建
      bootstrap.config.proxy = req.proxy;
      await reconfigureConnections();
      logger.info(
        { enabled: req.proxy.enabled, host: req.proxy.host, port: req.proxy.port },
        'proxy config updated (hot-reloaded)',
      );
    },
  );

  ipcMain.handle(
    'config:testProxy',
    async (
      _evt,
      req: IpcChannels['config:testProxy']['request'],
    ): Promise<IpcChannels['config:testProxy']['response']> => {
      return testProxyConnectivity(req.proxy);
    },
  );

  ipcMain.handle(
    'config:testConnection',
    async (
      _evt,
      req: IpcChannels['config:testConnection']['request'],
    ): Promise<IpcChannels['config:testConnection']['response']> => {
      // 用草稿 url/token 临时起 adapter ping，不落配置；失败归一成 ok:false + reason
      try {
        return await buildDraftAdapter(
          req.base_url,
          req.token,
          bootstrap.config.proxy,
          req.kind,
        ).ping();
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'config:autosaveDraft',
    async (_evt, req: IpcChannels['config:autosaveDraft']['request']): Promise<void> => {
      // 只写 config.yaml（含 base 非编辑字段），**不更新内存 config、不 reconfigure**：
      // 持久化防丢失但不生效。重启读文件 或 点底栏「保存」走 config:setConnections/setLlm 才应用。
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
    },
  );

  ipcMain.handle(
    'config:setPoller',
    async (_evt, req: IpcChannels['config:setPoller']['request']): Promise<void> => {
      // 防御性 clamp 到 60~900 整数（UI 已限制，这里兜底）
      const seconds = Math.min(900, Math.max(60, Math.round(req.interval_seconds)));
      const next = {
        ...bootstrap.config,
        poller: { ...bootstrap.config.poller, interval_seconds: seconds },
      };
      await writeConfig(bootstrap.paths.configFile, next);
      bootstrap.config.poller.interval_seconds = seconds;
      poller.setIntervalSeconds(seconds); // 热替换定时器，无需重启
      logger.info({ intervalSeconds: seconds }, 'poller interval updated (hot-reloaded)');
    },
  );
}
