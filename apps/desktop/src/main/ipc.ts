import * as agent from './controllers/agent.js';
import * as app from './controllers/app.js';
import * as config from './controllers/config.js';
import * as pr from './controllers/pr.js';
import { handle } from './controllers/register.js';
import { AgentOrchestratorService } from './services/agent-orchestrator.js';
import {
  createServiceContext,
  type ControllerContext,
  type RegisterDeps,
} from './services/context.js';
import { RunQueueService } from './services/run-queue.js';

export type { RegisterDeps } from './services/context.js';

/**
 * 注册全部 IPC handler。薄入口：构建共享上下文 → 建两个跨域 service（run 队列 / Agent 编排）
 * → 合成 controller 上下文 → 按业务领域逐个绑定通道 → 返回运行时控制句柄。
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
  // controller 层统一上下文：基础上下文 + 两个跨域 service，所有 controller 共享同一 ctx。
  const ctx: ControllerContext = { ...base, runQueue, orchestrator };

  /*
   * GUI 框架交互
   * 应用信息 / 窗口 / 外部打开 / 对话框 / 日志回传 / 连接与头像
   */
  handle('app:info', ctx, app.readAppInfo); // 应用 / 运行时版本信息（关于页）
  handle('app:paths', ctx, app.readAppPaths); // 关键目录路径（config / agent / 日志）
  handle('app:prAgentStatus', ctx, app.readPrAgentStatus); // pr-agent 探测状态（是否就绪）
  handle('log:write', ctx, app.writeRendererLog); // 渲染层日志回传落盘
  handle('app:connections', ctx, app.listConnections); // 当前活动连接摘要（Header / 状态栏）
  handle('app:userAvatar', ctx, app.getUserAvatar); // 用户头像（内存 + 磁盘两级缓存）
  handle('app:openConfigFile', ctx, app.openConfigFile); // 打开 config.yaml
  handle('app:openAgentDir', ctx, app.openAgentDir); // 打开 Agent 目录
  handle('app:openDevTools', ctx, app.openDevTools); // 打开 DevTools（分离窗口）
  handle('app:checkUpdate', ctx, app.checkUpdate); // 手动检查更新
  handle('app:getUpdateStatus', ctx, app.getUpdateStatus); // 读缓存的更新检测结果（水合）
  handle('app:openExternal', ctx, app.openExternal); // 系统浏览器打开外链
  handle('dialog:pickDirectory', ctx, app.pickDirectory); // 原生目录选择对话框

  /*
   * PR 操作
   * 评论 / 列表 / 状态 / 合并 / 镜像 / diff / 草稿 / pr-agent run 队列
   */
  handle('comments:reply', ctx, pr.replyComment); // 回复评论
  handle('comments:delete', ctx, pr.deleteComment); // 删除自己的评论
  handle('comments:edit', ctx, pr.editComment); // 编辑自己的评论
  handle('comments:fetchAttachment', ctx, pr.fetchAttachment); // 拉评论内嵌图片（代理带 PAT）
  handle('prs:list', ctx, pr.listPrs); // PR 列表（仅活动连接）
  handle('prs:refresh', ctx, pr.refreshPrs); // 立即轮询刷新
  handle('prs:lastSync', ctx, pr.getLastSync); // 最近一次同步时间
  handle('prs:setLocalStatus', ctx, pr.setPrStatus); // 设置审阅状态（先远端后本地）
  handle('prs:merge', ctx, pr.mergePr); // 合并 PR
  handle('repo:sync', ctx, pr.syncRepo); // 同步 PR 所属 repo 本地镜像
  handle('diff:listChangedFiles', ctx, pr.listChangedFiles); // 变更文件列表
  handle('diff:getFileContent', ctx, pr.getFileContent); // 文件内容（base / head 一侧）
  handle('diff:commentCountCached', ctx, pr.getCommentCountCached); // 评论数角标（仅缓存）
  handle('diff:listComments', ctx, pr.listComments); // 拉评论（缓存 + in-flight 去重）
  handle('diff:listCommits', ctx, pr.listCommits); // 提交列表
  handle('diff:commitCount', ctx, pr.getCommitCount); // 提交数角标（本地 git）
  handle('diff:getBlame', ctx, pr.getBlame); // blame + PR 引入行
  handle('repo:getTotalSize', ctx, pr.getTotalSize); // 本地镜像总占用（设置页）
  handle('pragent:run', ctx, pr.runPragent); // 触发一次 pr-agent run（入队）
  handle('pragent:cancel', ctx, pr.cancelPragent); // 取消一个 run
  handle('pragent:queue', ctx, pr.getQueue); // 队列快照（active + waiting）
  handle('pragent:listRuns', ctx, pr.listRuns); // 历史 run 列表（游标分页）
  handle('pragent:getRun', ctx, pr.getRun); // 单条 run 查询
  handle('pragent:clearRuns', ctx, pr.clearRuns); // 清空 run 历史 + Agent 会话 / 台账
  handle('drafts:list', ctx, pr.getDrafts); // 草稿列表
  handle('drafts:create', ctx, pr.addDraft); // 新建草稿
  handle('drafts:update', ctx, pr.patchDraft); // 更新草稿
  handle('drafts:delete', ctx, pr.removeDraft); // 删除草稿
  handle('drafts:publishBatch', ctx, pr.publishDraftBatch); // 批量发布草稿到远端

  /*
   * 配置操作
   * 读写 config.yaml（热生效 / 草稿暂存）及连接 / 代理试连
   */
  handle('config:read', ctx, config.readConfig); // 读当前内存配置
  handle('config:setReposDir', ctx, config.setReposDir); // 设仓库目录（重启生效）
  handle('config:setLanguage', ctx, config.setLanguage); // 设 UI 语言（热生效）
  handle('config:setLlm', ctx, config.setLlm); // 设 LLM Provider 配置
  handle('config:setAgent', ctx, config.setAgent); // 设 Agent 配置（含 agent.dir）
  handle('agent:setAutopilotEnabled', ctx, config.setAutopilotEnabled); // AutoPilot 开关
  handle('config:setConnections', ctx, config.setConnections); // 设连接（热重建 adapter/poller）
  handle('config:setProxy', ctx, config.setProxy); // 设代理（热重建 adapter）
  handle('config:testProxy', ctx, config.testProxy); // 试连代理（不写配置）
  handle('config:testConnection', ctx, config.testConnection); // 试连连接（不写配置）
  handle('config:autosaveDraft', ctx, config.autosaveDraft); // 连接 / LLM 草稿存盘（不生效）
  handle('config:setPoller', ctx, config.setPoller); // 设轮询间隔（热替换定时器）

  /*
   * Agent 交互
   * 规则匹配 / 评审编排 / 自由规划 / 会话与台账读取
   */
  handle('rules:matchForPr', ctx, agent.matchRuleForPr); // 查 PR 命中的规则
  handle('agent:run', ctx, agent.runReview); // 一键评审编排（describe→review→总结）
  handle('agent:ask', ctx, agent.runPlanning); // 自由规划 Agent（对话即委派）
  handle('agent:stop', ctx, agent.stopAgent); // 停止某 PR 的 Agent 运行
  handle('agent:getSession', ctx, agent.getSession); // 读已落盘评审会话
  handle('agent:getConversation', ctx, agent.getConversation); // 读多轮对话消息
  handle('agent:getTranscript', ctx, agent.getTranscript); // 读 Agent 过程步骤
  handle('agent:autopilotLedgers', ctx, agent.getAutopilotLedgers); // 批量读 AutoPilot 评审台账

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
