import { ipcMain } from 'electron';
import * as agent from './controllers/agent.js';
import * as app from './controllers/app.js';
import * as config from './controllers/config.js';
import * as pr from './controllers/pr.js';
import { AgentOrchestratorService } from './services/agent-orchestrator.js';
import {
  createServiceContext,
  setControllerContext,
  type ControllerContext,
  type RegisterDeps,
} from './services/context.js';
import { RunQueueService } from './services/run-queue.js';

export type { RegisterDeps } from './services/context.js';

/**
 * 注册全部 IPC handler。薄入口：构建共享上下文 → 建两个跨域 service（run 队列 / Agent 编排）
 * → 合成 controller 上下文并安装为进程级单例 → 按业务领域逐个绑定通道 → 返回运行时控制句柄。
 *
 * controller 是原生 ipcMain.handle 监听器（具名函数 `(event, req) => …`，见 controllers/<域>.ts），
 * 依赖经 getContext() 取用、不带 ctx 参数；下方直接 `ipcMain.handle('channel', controller)` 注册，无包装层。
 */
export function registerIpcHandlers(deps: RegisterDeps): {
  abortAllActiveRuns: () => number;
  runAutopilotIfDue: () => void;
  terminateAgentsForGonePrs: () => void;
} {
  const base = createServiceContext(deps);
  // run 队列：pragent:run（PR 域）、Agent 编排、AutoPilot 三方共用。
  const runQueue = new RunQueueService(base);
  // Agent 编排：复用 run 队列派发工具 run（agent 低优先级泳道）。
  const orchestrator = new AgentOrchestratorService(base, runQueue);
  // controller 层统一上下文：基础上下文 + 两个跨域 service，安装为进程级单例（controller 经 getContext() 取用）。
  const ctx: ControllerContext = { ...base, runQueue, orchestrator };
  setControllerContext(ctx);

  /*
   * GUI 框架交互
   * 应用信息 / 窗口 / 外部打开 / 对话框 / 日志回传 / 连接与头像
   */
  ipcMain.handle('app:info', app.readAppInfo); // 应用 / 运行时版本信息（关于页）
  ipcMain.handle('app:paths', app.readAppPaths); // 关键目录路径（config / agent / 日志）
  ipcMain.handle('app:prAgentStatus', app.readPrAgentStatus); // pr-agent 探测状态（是否就绪）
  ipcMain.handle('log:write', app.writeRendererLog); // 渲染层日志回传落盘
  ipcMain.handle('app:connections', app.listConnections); // 当前活动连接摘要（Header / 状态栏）
  ipcMain.handle('app:userAvatar', app.getUserAvatar); // 用户头像（内存 + 磁盘两级缓存）
  ipcMain.handle('app:openConfigFile', app.openConfigFile); // 打开 config.yaml
  ipcMain.handle('app:openAgentDir', app.openAgentDir); // 打开 Agent 目录
  ipcMain.handle('app:openDevTools', app.openDevTools); // 打开 DevTools（分离窗口）
  ipcMain.handle('app:checkUpdate', app.checkUpdate); // 手动检查更新
  ipcMain.handle('app:getUpdateStatus', app.getUpdateStatus); // 读缓存的更新检测结果（水合）
  ipcMain.handle('app:openExternal', app.openExternal); // 系统浏览器打开外链
  ipcMain.handle('dialog:pickDirectory', app.pickDirectory); // 原生目录选择对话框

  /*
   * PR 操作
   * 评论 / 列表 / 状态 / 合并 / 镜像 / diff / 草稿 / pr-agent run 队列
   */
  ipcMain.handle('comments:reply', pr.replyComment); // 回复评论
  ipcMain.handle('comments:delete', pr.deleteComment); // 删除自己的评论
  ipcMain.handle('comments:edit', pr.editComment); // 编辑自己的评论
  ipcMain.handle('comments:fetchAttachment', pr.fetchAttachment); // 拉评论内嵌图片（代理带 PAT）
  ipcMain.handle('prs:list', pr.listPrs); // PR 列表（仅活动连接）
  ipcMain.handle('prs:refresh', pr.refreshPrs); // 立即轮询刷新
  ipcMain.handle('prs:lastSync', pr.getLastSync); // 最近一次同步时间
  ipcMain.handle('prs:setLocalStatus', pr.setPrStatus); // 设置审阅状态（先远端后本地）
  ipcMain.handle('prs:merge', pr.mergePr); // 合并 PR
  ipcMain.handle('repo:sync', pr.syncRepo); // 同步 PR 所属 repo 本地镜像
  ipcMain.handle('diff:listChangedFiles', pr.listChangedFiles); // 变更文件列表
  ipcMain.handle('diff:getFileContent', pr.getFileContent); // 文件内容（base / head 一侧）
  ipcMain.handle('diff:commentCountCached', pr.getCommentCountCached); // 评论数角标（仅缓存）
  ipcMain.handle('diff:listComments', pr.listComments); // 拉评论（缓存 + in-flight 去重）
  ipcMain.handle('diff:listCommits', pr.listCommits); // 提交列表
  ipcMain.handle('diff:listActivity', pr.listActivity); // 评审决断活动事件（时间线）
  ipcMain.handle('diff:commitCount', pr.getCommitCount); // 提交数角标（本地 git）
  ipcMain.handle('diff:getBlame', pr.getBlame); // blame + PR 引入行
  ipcMain.handle('repo:getTotalSize', pr.getTotalSize); // 本地镜像总占用（设置页）
  ipcMain.handle('drafts:list', pr.getDrafts); // 草稿列表
  ipcMain.handle('drafts:create', pr.addDraft); // 新建草稿
  ipcMain.handle('drafts:update', pr.patchDraft); // 更新草稿
  ipcMain.handle('drafts:delete', pr.removeDraft); // 删除草稿
  ipcMain.handle('drafts:publishBatch', pr.publishDraftBatch); // 批量发布草稿到远端

  /*
   * 配置操作
   * 读写 config.yaml（热生效 / 草稿暂存）及连接 / 代理试连
   */
  ipcMain.handle('config:read', config.readConfig); // 读当前内存配置
  ipcMain.handle('config:setReposDir', config.setReposDir); // 设仓库目录（重启生效）
  ipcMain.handle('config:setLanguage', config.setLanguage); // 设 UI 语言（热生效）
  ipcMain.handle('config:setLlm', config.setLlm); // 设 LLM Provider 配置
  ipcMain.handle('config:setAgent', config.setAgent); // 设 Agent 配置（含 agent.dir）
  ipcMain.handle('agent:setAutopilotEnabled', config.setAutopilotEnabled); // AutoPilot 开关
  ipcMain.handle('config:setConnections', config.setConnections); // 设连接（热重建 adapter/poller）
  ipcMain.handle('config:setProxy', config.setProxy); // 设代理（热重建 adapter）
  ipcMain.handle('config:testProxy', config.testProxy); // 试连代理（不写配置）
  ipcMain.handle('config:testConnection', config.testConnection); // 试连连接（不写配置）
  ipcMain.handle('config:autosaveDraft', config.autosaveDraft); // 连接 / LLM 草稿存盘（不生效）
  ipcMain.handle('config:setPoller', config.setPoller); // 设轮询间隔（热替换定时器）

  /*
   * Agent 交互
   * 规则匹配 / 评审编排 / 自由规划 / 会话与台账读取 / pr-agent run 队列
   */
  ipcMain.handle('rules:matchForPr', agent.matchRuleForPr); // 查 PR 命中的规则
  ipcMain.handle('agent:run', agent.runReview); // 一键评审编排（describe→review→总结）
  ipcMain.handle('agent:ask', agent.runPlanning); // 自由规划 Agent（对话即委派）
  ipcMain.handle('agent:stop', agent.stopAgent); // 停止某 PR 的 Agent 运行
  ipcMain.handle('agent:getSession', agent.getSession); // 读已落盘评审会话
  ipcMain.handle('agent:getConversation', agent.getConversation); // 读多轮对话消息
  ipcMain.handle('agent:getTranscript', agent.getTranscript); // 读 Agent 过程步骤
  ipcMain.handle('agent:autopilotLedgers', agent.getAutopilotLedgers); // 批量读 AutoPilot 评审台账
  ipcMain.handle('pragent:run', agent.runPragent); // 触发一次 pr-agent run（入队）
  ipcMain.handle('pragent:cancel', agent.cancelPragent); // 取消一个 run
  ipcMain.handle('pragent:queue', agent.getQueue); // 队列快照（active + waiting）
  ipcMain.handle('pragent:listRuns', agent.listRuns); // 历史 run 列表（游标分页）
  ipcMain.handle('pragent:getRun', agent.getRun); // 单条 run 查询
  ipcMain.handle('pragent:clearRuns', agent.clearRuns); // 清空 run 历史 + Agent 会话 / 台账

  base.logger.debug('IPC handlers registered');

  return {
    /**
     * 应用退出时调用：中止所有进行中的 run。每个 run 的 AbortController.abort() 会触发 exec 的
     * onAbort → killTree（进程树级杀），连带终止 python 及其 litellm 等孙进程，避免孤儿进程锁住
     * 安装目录导致升级安装失败。返回被中止的 run 数，供调用方决定是否需要短暂等待 taskkill 跑完。
     */
    abortAllActiveRuns: () => runQueue.abortAllActiveRuns(),
    /** 每次 poll tick 由 index.ts 调用：满足开关 + 候选时跑一遍 AutoPilot pass。 */
    runAutopilotIfDue: () => orchestrator.runAutopilotIfDue(),
    /** 每次 poll tick 由 index.ts 调用：终止已被移除 / purge 的 PR 上仍在执行的 agent 操作。 */
    terminateAgentsForGonePrs: () => void orchestrator.terminateAgentsForGonePrs(),
  };
}
