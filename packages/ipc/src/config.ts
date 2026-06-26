import type {
  Config,
  EditorTheme,
  PingResult,
  PlatformKind,
  SupportedLanguage,
} from '@meebox/shared';

/** 配置操作域：读 / 写 config.yaml（含热生效与草稿暂存）及连接 / 代理试连。 */
export interface ConfigChannels {
  'config:read': { request: void; response: Config };
  /** 写入新的 repos_dir 到 config.yaml；重启生效 */
  'config:setReposDir': { request: { reposDir: string }; response: void };
  /**
   * 写入 UI 语言到 config.yaml 并**即时生效**：主进程 i18n 立刻 changeLanguage（后续 dialog/
   * 错误文案 + 下次 pragent:run 的响应语言随之），渲染层另行 i18n.changeLanguage 实时切换。
   * 与代理/连接同属热生效项，无需依赖设置页全局保存。
   */
  'config:setLanguage': { request: { language: SupportedLanguage }; response: void };
  /**
   * 写入外观（全局主题 = Monaco 配色主题 + 等宽字体族 + 字号）到 config.yaml。主题切换由 renderer 即时
   * 完成（Monaco theme + data-theme + chrome 派生 + 字体 CSS 变量）；主进程据主题设原生窗口 themeSource。
   */
  'config:setEditorAppearance': {
    request: { editor_theme: EditorTheme; editor_font_family: string; editor_font_size: number };
    response: void;
  };
  /** 写入 LLM Provider 配置到 config.yaml；下次 pragent:run 自动用新值 */
  'config:setLlm': { request: { llm: Config['llm'] }; response: void };
  /** 写入 agent.dir 到 config.yaml；下次 pragent:run 立即生效 (现读规则) */
  'config:setAgent': { request: { agent: Config['agent'] }; response: void };
  /** 翻转 AutoPilot 开关 (agent.autopilot.enabled) 并写 config.yaml；下次 poll tick 生效。 */
  'agent:setAutopilotEnabled': { request: { enabled: boolean }; response: void };
  /** 写入轮询间隔 (秒，60~900 整数) 到 config.yaml，并热替换 poller 定时器，无需重启 */
  'config:setPoller': { request: { interval_seconds: number }; response: void };
  /** 写入评审任务并发数 (1~8 整数, pr_agent.max_concurrency) 到 config.yaml，并热替换 run 队列上限，无需重启 */
  'config:setMaxConcurrency': { request: { max_concurrency: number }; response: void };
  /**
   * 写入网络代理配置到 config.yaml，并**热重建** adapter（REST 经代理即时生效）。
   * pr-agent / git 出口下次操作读最新配置，无需重启。
   */
  'config:setProxy': { request: { proxy: Config['proxy'] }; response: void };
  /** 用给定代理配置试连一个外部地址，验证代理是否可用；不写配置。 */
  'config:testProxy': {
    request: { proxy: Config['proxy'] };
    response: { ok: boolean; reason?: string };
  };
  /**
   * 写入连接列表 + 当前启用连接到 config.yaml，并**热重建** adapter/poller 即时生效
   * （无需重启）。active 那条被轮询，其余仅保留配置。
   */
  'config:setConnections': {
    request: { connections: Config['connections']; active_connection_id: string };
    response: void;
  };
  /** 用草稿 url/token 临时起 adapter ping，保存前测试连接是否可达；不写配置。 */
  'config:testConnection': {
    request: { base_url: string; token: string; kind?: PlatformKind };
    response: PingResult;
  };
  /**
   * 配置过程中自动把连接 + LLM 草稿写入 config.yaml（防丢失），但**不应用到运行时**
   * （不 reconfigure adapter/poller、不更新内存 config）——重启或点底栏「保存」才生效。
   */
  'config:autosaveDraft': {
    request: {
      connections: Config['connections'];
      active_connection_id: string;
      llm: Config['llm'];
    };
    response: void;
  };
}
