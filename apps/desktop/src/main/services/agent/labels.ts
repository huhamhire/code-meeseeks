import type { AgentStepLabels } from '@meebox/agent';
import { t } from '../../i18n/index.js';

/**
 * Resolve agent step display text / summary skeleton / abort reason from the main-process i18n resources
 * (`agent.*` in locales/*.json) and inject them into the pure-logic agent orchestrator — the agent keeps only the
 * en-US fallback, and multilingual translations are maintained uniformly in the i18n resources.
 * Resolved via the session language (= getMainLanguage, t()'s current language), consistent with the UI; step text is materialized at generation time and persisted with the transcript.
 */

/** Build step display text from i18n resources (judgeSevere uses i18next plural count). */
export function buildStepLabels(): AgentStepLabels {
  return {
    describeReview: t('agent.steps.describeReview'),
    improve: t('agent.steps.improve'),
    judge: t('agent.steps.judge'),
    judgeSevere: (n) => t('agent.steps.judgeSevere', { count: n }),
    judgeNone: t('agent.steps.judgeNone'),
    summary: t('agent.steps.summary'),
    rejectedPrefix: t('agent.steps.rejectedPrefix'),
  };
}

/** Build the three-section review summary skeleton titles from i18n resources (overview / key findings / suggestions). */
export function buildSummarySections(): [string, string, string] {
  return [
    t('agent.summarySections.overview'),
    t('agent.summarySections.findings'),
    t('agent.summarySections.suggestions'),
  ];
}

/**
 * Map the stable abort-reason code returned by the agent to localized text: 'aborted' / 'max_steps' via the i18n
 * resources; others (the specific error message from the failed branch) are returned as-is. Called before persisting so
 * that session.terminationReason is already target-language text (the renderer displays it verbatim).
 */
export function mapTerminationReason(code: string | undefined): string | undefined {
  if (code === 'aborted') return t('agent.termination.aborted');
  if (code === 'max_steps') return t('agent.termination.maxSteps');
  return code;
}
