import type { AgentStepLabels } from '@meebox/agent';
import { t } from '../../i18n/index.js';

/**
 * 把 agent 步骤展示文案 / 总结骨架 / 中止原因从主进程 i18n 资源（locales/*.json 的 `agent.*`）解析出来，
 * 注入纯逻辑的 agent 编排器——agent 内仅留 en-US 兜底，多语言译文统一在 i18n 资源维护。
 * 经会话语言（= getMainLanguage，t() 当前语言）解析，与 UI 一致；步骤文案在生成时落地、随 transcript 持久化。
 */

/** 从 i18n 资源构造步骤展示文案（judgeSevere 走 i18next 复数 count）。 */
export function buildStepLabels(): AgentStepLabels {
  return {
    describeReview: t('agent.steps.describeReview'),
    improve: t('agent.steps.improve'),
    judge: t('agent.steps.judge'),
    judgeSevere: (n) => t('agent.steps.judgeSevere', { count: n }),
    judgeNone: t('agent.steps.judgeNone'),
    summary: t('agent.steps.summary'),
    parseFail: t('agent.steps.parseFail'),
    rejectedPrefix: t('agent.steps.rejectedPrefix'),
  };
}

/** 从 i18n 资源构造评审总结三段骨架标题（概述 / 关键发现 / 建议）。 */
export function buildSummarySections(): [string, string, string] {
  return [
    t('agent.summarySections.overview'),
    t('agent.summarySections.findings'),
    t('agent.summarySections.suggestions'),
  ];
}

/**
 * 把 agent 返回的中止原因稳定 code 映射为本地化文案：'aborted' / 'max_steps' 经 i18n 资源；其它（failed
 * 分支的具体错误信息）原样返回。落盘前调用，使 session.terminationReason 即为目标语言文本（渲染层逐字显示）。
 */
export function mapTerminationReason(code: string | undefined): string | undefined {
  if (code === 'aborted') return t('agent.termination.aborted');
  if (code === 'max_steps') return t('agent.termination.maxSteps');
  return code;
}
