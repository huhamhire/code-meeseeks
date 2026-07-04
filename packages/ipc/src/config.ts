import type {
  Config,
  EditorTheme,
  PingResult,
  PlatformKind,
  SupportedLanguage,
} from '@meebox/shared';

/** Config operations domain: read / write config.yaml (including hot-apply and draft staging) and connection / proxy test-connect. */
export interface ConfigChannels {
  'config:read': { request: void; response: Config };
  /** Write the new repos_dir to config.yaml; effective on restart */
  'config:setReposDir': { request: { reposDir: string }; response: void };
  /**
   * Write the UI language to config.yaml and **apply immediately**: the main process i18n calls changeLanguage right away (subsequent dialog/
   * error text + the next pragent:run's response language follow), and the renderer separately does i18n.changeLanguage to switch in real time.
   * Like proxy/connection, it's a hot-apply item, not dependent on the Settings page's global save.
   */
  'config:setLanguage': { request: { language: SupportedLanguage }; response: void };
  /**
   * Write appearance (global theme = Monaco color theme + monospace font family + font size) to config.yaml. Theme switching is done by the renderer
   * immediately (Monaco theme + data-theme + chrome derivation + font CSS variables); the main process sets the native window themeSource per theme.
   */
  'config:setEditorAppearance': {
    request: { editor_theme: EditorTheme; editor_font_family: string; editor_font_size: number };
    response: void;
  };
  /** Write LLM Provider config to config.yaml; the next pragent:run automatically uses the new values */
  'config:setLlm': { request: { llm: Config['llm'] }; response: void };
  /** Write agent.dir to config.yaml; effective on the next pragent:run (rules read at that time) */
  'config:setAgent': { request: { agent: Config['agent'] }; response: void };
  /** Write message notification config (master switch + per-category system notifications + dock badge) to config.yaml; synced in memory, the next poll/badge uses the new values. */
  'config:setNotifications': { request: { notifications: Config['notifications'] }; response: void };
  /** Flip the AutoPilot switch (agent.autopilot.enabled) and write config.yaml; effective on the next poll tick. */
  'agent:setAutopilotEnabled': { request: { enabled: boolean }; response: void };
  /** Write the poll interval (seconds, integer 60~900) to config.yaml and hot-swap the poller timer, no restart needed */
  'config:setPoller': { request: { interval_seconds: number }; response: void };
  /** Write the review-task concurrency (integer 1~8, pr_agent.max_concurrency) to config.yaml and hot-swap the run queue cap, no restart needed */
  'config:setMaxConcurrency': { request: { max_concurrency: number }; response: void };
  /**
   * Write network proxy config to config.yaml and **hot-rebuild** the adapter (REST via proxy takes effect immediately).
   * pr-agent / git egress reads the latest config on the next operation, no restart needed.
   */
  'config:setProxy': { request: { proxy: Config['proxy'] }; response: void };
  /** Test-connect to an external address with the given proxy config to validate whether the proxy works; does not write config. */
  'config:testProxy': {
    request: { proxy: Config['proxy'] };
    response: { ok: boolean; reason?: string };
  };
  /**
   * Write the connection list + currently active connection to config.yaml and **hot-rebuild** the adapter/poller to take effect immediately
   * (no restart needed). The active one is polled, the rest only keep their config.
   */
  'config:setConnections': {
    request: { connections: Config['connections']; active_connection_id: string };
    response: void;
  };
  /** Temporarily start an adapter ping with draft url/token to test whether the connection is reachable before saving; does not write config. */
  'config:testConnection': {
    request: { base_url: string; token: string; kind?: PlatformKind };
    response: PingResult;
  };
  /**
   * Write local API service listen config (switch / host / port / token) to config.yaml and **hot-rebuild** the listener
   * (switch / address / port changes stop the old and start new; token changes take effect on the next request). See docs/arch/04-integration/01-service-api.md.
   */
  'config:setService': { request: { service: Config['service'] }; response: void };
  /** Regenerate the bearer token and write to disk (the old token is invalidated immediately), returning the new token for the Settings page to display / copy. */
  'config:generateServiceToken': { request: void; response: { token: string } };
  /**
   * During configuration, automatically write the connection + LLM draft to config.yaml (to prevent loss), but **do not apply to the runtime**
   * (no reconfigure of adapter/poller, no update of the in-memory config)—effective only on restart or clicking the bottom-bar "Save".
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
