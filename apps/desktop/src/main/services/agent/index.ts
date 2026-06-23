/**
 * Agent 编排域：会话 Agent（手动评审 / 自由规划 / AutoPilot）的主进程接线。Orchestrator 为对外能力入口，
 * review / planning（微流程与规划的主进程 runner）+ labels（i18n 文案注入）为域内协作件，不外暴露。
 */
export { Orchestrator } from './orchestrator.js';
