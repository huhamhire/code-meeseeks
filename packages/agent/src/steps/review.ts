import type { AgentRecommendation, AgentRecommendationVerdict } from '@meebox/shared';
import {
  extractJson,
  salvageProse,
  stripTrailingJson,
  summarySections,
  type AgentStepLabels,
  type ReviewOrchestratorDeps,
  type ReviewOrchestratorInput,
  type ToolText,
} from '../orchestrator.js';
import { PROMPT_TEMPLATES, fillTemplate } from '../prompts.js';
import { runStaggered } from '../stagger.js';
import type { StepHandler, StepRecorder } from './context.js';

/**
 * 评审微流程的步骤（见 docs/arch/06-agent.md「AutoPilot」的有界微流程）：describe → review →
 * （仅严重问题）条件追问 ≤N → 收尾总结 + 建议。每段是一个 StepHandler，由 orchestrator 顺序跑 REVIEW_STEPS、
 * 共享 StepRecorder + bag 传递中间产物。判读 / 总结的提示词与解析就近放在此（与步骤同域维护）。
 */

const VERDICTS: readonly AgentRecommendationVerdict[] = ['approve', 'needs_work', 'manual_review'];
function isVerdict(v: unknown): v is AgentRecommendationVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

/** 追问判断用的精简系统提示：不带 agent 完整上下文（SOUL / 记忆 / 用户档 / 工具目录 / 规则 / PR 元数据）。
 *  这是一次轻量路由判读，仅凭 describe + review 结果判「是否有严重问题需追问」，与 AutoPilot 初判同思路。 */
const JUDGE_SYSTEM =
  'You are a senior code reviewer triaging review findings for follow-up. Be decisive and terse; reply with JSON only, no reasoning.';

/** 追问判读的输出 token 上限：产物是极小 JSON（severe + 至多数条问题），无需大额度。 */
const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** 追问判读 user 指令外置在 resources/prompts/judge.md（占位 maxAsks/language）；describe/review 正文在此追加。
 *  语言显式要求随会话语言出题（精简 system 不带 assembleSystemContext 的语言指令，否则默认英文）。 */
function judgePrompt(
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
function summaryPrompt(
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

// 1. describe + review（固定两步，并行——彼此独立、都只读 PR，无先后依赖；实际并发度受运行队列约束，
//    错开 100~200ms 起跑）。类 Claude Code：先把所选步骤作为一步流式出去（思考在前），工具执行进度 /
//    计时由 run 卡片承载，不为每个工具补记 tool 步。
const describeReviewStep: StepHandler<ReviewStepCtx> = {
  name: 'describe-review',
  run: async (ctx) => {
    ctx.checkAbort();
    await ctx.rec.record({
      kind: 'plan',
      thought: ctx.labels.describeReview,
      toolCall: { tool: 'describe + review' },
    });
    const [describe, review] = await runStaggered(
      [{ tool: 'describe' as const }, { tool: 'review' as const }],
      (c) => ctx.deps.runTool(c),
    );
    ctx.rec.track(describe.usage);
    ctx.rec.track(review.usage);
    ctx.bag.describe = describe;
    ctx.bag.review = review;
  },
};

// 2. 仅严重问题条件性追问的判读（精简 system 轻量路由 + 输出封顶）。
const judgeStep: StepHandler<ReviewStepCtx> = {
  name: 'judge',
  run: async (ctx) => {
    ctx.checkAbort();
    const judgeStart = Date.now();
    const judge = await ctx.deps.chat({
      system: JUDGE_SYSTEM,
      user: judgePrompt(
        ctx.bag.describe!.text,
        ctx.bag.review!.text,
        ctx.maxAsks,
        ctx.input.language ?? '',
      ),
      // 判读产物只是极小 JSON（severe + 至多数条问题），封顶输出避免对 yes/no 决策狂吐 token。
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    const judgeMs = Date.now() - judgeStart;
    ctx.rec.track(judge.usage);
    const verdict = extractJson<{ severe?: boolean; questions?: string[] }>(judge.text);
    const questions = verdict?.severe ? (verdict.questions ?? []).slice(0, ctx.maxAsks) : [];
    ctx.bag.questions = questions;
    await ctx.rec.record({
      kind: 'judge',
      thought: ctx.labels.judge,
      result: questions.length ? ctx.labels.judgeSevere(questions.length) : ctx.labels.judgeNone,
      thinkMs: judgeMs,
      usage: judge.usage,
    });
  },
};

// 多个追问同属一个阶段、彼此独立，故并行派发（runStaggered 保序、错开起跑；questions 为空不触发）。
const asksStep: StepHandler<ReviewStepCtx> = {
  name: 'asks',
  run: async (ctx) => {
    ctx.checkAbort();
    const { questions } = ctx.bag;
    const asks = questions.length
      ? await runStaggered(questions, (q) => ctx.deps.runTool({ tool: 'ask', question: q }))
      : [];
    ctx.bag.askResults = asks.map((ask, i) => {
      ctx.rec.track(ask.usage);
      return `Q: ${questions[i]}\nA: ${ask.text}`;
    });
  },
};

// 3. 收尾总结 + 建议。解析失败兜底打捞散文 + 剥末尾判定 JSON；**不做硬截断**。
const summaryStep: StepHandler<ReviewStepCtx> = {
  name: 'summary',
  run: async (ctx) => {
    ctx.checkAbort();
    const sumStart = Date.now();
    const sum = await ctx.deps.chat({
      system: ctx.system,
      user: summaryPrompt(
        ctx.bag.describe!.text,
        ctx.bag.review!.text,
        ctx.bag.askResults,
        ctx.summaryMax,
        summarySections(ctx.input.language),
      ),
    });
    const sumMs = Date.now() - sumStart;
    ctx.rec.track(sum.usage);
    const parsed = extractJson<{
      summary?: string;
      recommendation?: { verdict?: unknown; reason?: unknown };
    }>(sum.text);
    const summary = stripTrailingJson(parsed?.summary ?? salvageProse(sum.text)).trim();
    const recommendation: AgentRecommendation =
      parsed?.recommendation && isVerdict(parsed.recommendation.verdict)
        ? {
            verdict: parsed.recommendation.verdict,
            reason:
              typeof parsed.recommendation.reason === 'string' ? parsed.recommendation.reason : '',
          }
        : { verdict: 'manual_review', reason: ctx.labels.parseFail };
    ctx.bag.summary = summary;
    ctx.bag.recommendation = recommendation;
    await ctx.rec.record({
      kind: 'plan',
      thought: ctx.labels.summary,
      result: summary,
      thinkMs: sumMs,
      usage: sum.usage,
    });
  },
};

/** 评审微流程的步骤注册表（有序执行）。新增 / 调整阶段在此组合，驱动无需改动。 */
export const REVIEW_STEPS: ReadonlyArray<StepHandler<ReviewStepCtx>> = [
  describeReviewStep,
  judgeStep,
  asksStep,
  summaryStep,
];
