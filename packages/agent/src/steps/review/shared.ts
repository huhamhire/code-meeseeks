import type { AgentRecommendation, AgentRecommendationVerdict } from '@meebox/shared';
import type {
  AgentStepLabels,
  ReviewOrchestratorDeps,
  ReviewOrchestratorInput,
  ToolText,
} from '../../orchestrator.js';
import { PROMPT_TEMPLATES, fillTemplate } from '../../prompts.js';
import type { StepRecorder } from '../context.js';

/**
 * 评审微流程各 step 的共享件：跨步骤上下文 / 累加器 + 判读 / 总结的提示词与判定解析。各 *-step.ts 引用此处，
 * 注册表见 ./index。
 */

const VERDICTS: readonly AgentRecommendationVerdict[] = ['approve', 'needs_work', 'manual_review'];

/** verdict 合法性判定（用于收尾解析；非法 / 缺省回落 manual_review）。 */
export function isVerdict(v: unknown): v is AgentRecommendationVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

/** 追问判断用的精简系统提示：不带 agent 完整上下文（SOUL / 记忆 / 用户档 / 工具目录 / 规则 / PR 元数据）。
 *  这是一次轻量路由判读，仅凭 describe + review 结果判「是否有严重问题需追问」，与 AutoPilot 初判同思路。 */
export const JUDGE_SYSTEM =
  'You are a senior code reviewer triaging review findings for follow-up. Be decisive and terse; reply with JSON only, no reasoning.';

/** 追问判读的输出 token 上限：产物是极小 JSON（severe + 至多数条问题），无需大额度。 */
export const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** 追问判读 user 指令外置在 resources/prompts/judge.md（占位 maxAsks/language）；describe/review 正文在此追加。
 *  语言显式要求随会话语言出题（精简 system 不带 assembleSystemContext 的语言指令，否则默认英文）。 */
export function judgePrompt(
  describeText: string,
  reviewText: string,
  maxAsks: number,
  language: string,
): string {
  // 与 renderLanguage 同策略：空 / 未知回落 en-US。
  const lang = language.trim() || 'en-US';
  const head = fillTemplate(PROMPT_TEMPLATES.judge, { maxAsks: String(maxAsks), language: lang });
  return [head, '', '--- PR description ---', describeText, '', '--- Review findings ---', reviewText].join(
    '\n',
  );
}

/** 收尾总结 user 指令 + 三段骨架外置在 resources/prompts/summary.md（占位 maxChars/三段标题）；
 *  描述 / 评审发现 / 追问 Q&A 等正文在此按需追加（条件拼接仍在 TS）。 */
export function summaryPrompt(
  describeText: string,
  reviewText: string,
  askResults: string[],
  maxChars: number,
  sections: readonly [string, string, string],
): string {
  const [overview, findings, suggestions] = sections;
  const head = fillTemplate(PROMPT_TEMPLATES.summary, {
    maxChars: String(maxChars),
    overview,
    findings,
    suggestions,
  });
  return [
    head,
    '',
    '--- Description ---',
    describeText,
    '',
    '--- Review findings ---',
    reviewText,
    ...(askResults.length ? ['', '--- Follow-up Q&A ---', askResults.join('\n\n')] : []),
  ].join('\n');
}

/** 跨步骤传递的中间产物。 */
export interface ReviewBag {
  describe?: ToolText;
  review?: ToolText;
  /** judge 判出的追问问题（asks 步消费）。 */
  questions: string[];
  askResults: string[];
  summary?: string;
  recommendation?: AgentRecommendation;
}

/** 评审步骤的运行上下文：依赖 + 输入 + 共享记录器 + 跨步骤累加器（bag）。 */
export interface ReviewStepCtx {
  deps: ReviewOrchestratorDeps;
  input: ReviewOrchestratorInput;
  rec: StepRecorder;
  /** 用户停止：每步边界检查，已 abort 即抛 `用户暂停`（思考阶段也能立即中止）。 */
  checkAbort: () => void;
  maxAsks: number;
  summaryMax: number;
  labels: AgentStepLabels;
  /** 微流程完整 system 上下文（summary 用；judge 另用精简 JUDGE_SYSTEM）。 */
  system: string;
  bag: ReviewBag;
}
