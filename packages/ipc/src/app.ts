import type { AppInfo, AppPaths, PrAgentStatus, UpdateCheckResult } from '@meebox/shared';
import type { ConnectionSummary } from './common.js';

/** GUI 框架交互域：应用信息 / 框架窗口 / 外部打开 / 对话框 / 日志回传 / 连接与头像。 */
export interface AppChannels {
  'app:info': { request: void; response: AppInfo };
  'app:paths': { request: void; response: AppPaths };
  'app:prAgentStatus': { request: void; response: PrAgentStatus };
  /** 调 Electron shell.openPath 让 OS 默认编辑器打开 config.yaml */
  'app:openConfigFile': { request: void; response: void };
  /** 调 shell.openPath 在系统文件管理器打开当前生效的 Agent 目录（不存在则先建）。 */
  'app:openAgentDir': { request: void; response: void };
  /** 打开 Electron DevTools（分离窗口） */
  'app:openDevTools': { request: void; response: void };
  /** 手动检测版本更新（设置页「检查更新」）。仅检测 + 返回结果，不下载 / 安装；
   *  结果同时缓存进 main 单一真相源并在有新版时广播 app:updateAvailable，使状态栏同步。 */
  'app:checkUpdate': { request: void; response: UpdateCheckResult };
  /** 读取 main 缓存的最近一次成功更新检测结果（不发起网络请求）。供窗口 / 状态栏挂载时水合，
   *  无缓存（尚未检测过）时返回 null。 */
  'app:getUpdateStatus': { request: void; response: UpdateCheckResult | null };
  /**
   * 渲染层日志回传：把渲染进程的错误 / 未捕获异常转发到 main，落进同一份 meebox.log
   * （renderer 自己的 console 不进文件）。preload 装 window.onerror / unhandledrejection
   * 调用。`scope` 固定 'renderer'，`meta` 任意结构化上下文（如 stack / url）。
   */
  'log:write': {
    request: {
      level: 'error' | 'warn' | 'info' | 'debug';
      msg: string;
      meta?: Record<string, unknown>;
    };
    response: void;
  };
  /**
   * 用系统默认浏览器打开 URL (shell.openExternal)。评论 markdown 内链点击 → 强制
   * 外部打开，避免 Electron 在 app window 内跳转覆盖整个界面
   */
  'app:openExternal': { request: { url: string }; response: void };
  /**
   * 调起系统原生目录选择对话框；用户取消返回 path: null。
   * defaultPath 可空，作为初始定位目录。
   */
  'dialog:pickDirectory': {
    request: { defaultPath?: string; title?: string };
    response: { path: string | null };
  };
  /** 各连接的 ping 后缓存：当前用户 + display_name，Header 用 */
  'app:connections': { request: void; response: ConnectionSummary[] };
  /**
   * 按 (connectionId, slug) 拉用户头像 data URL；主进程缓存命中直接返回。
   * 平台不支持 / 网络失败 / 用户无头像时返回 null，renderer 走 initials 回退。
   */
  'app:userAvatar': {
    // avatarUrl 可选：平台返回的头像直链（GitHub 机器人必须靠它）；缺省时 main 按 slug 推导
    request: { connectionId: string; slug: string; avatarUrl?: string };
    response: { dataUrl: string } | null;
  };
}
