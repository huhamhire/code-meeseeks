import type { Rule } from '@meebox/rules';
import type {
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentStep,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import { runStaggered } from './stagger.js';
import type { AgentContext } from './types.js';

/**
 * 结构化「评审微流程」编排器（见 docs/arch/06-agent.md「AutoPilot」的有界微流程）：
 * describe → review →（仅严重问题）条件性追问 ≤N → 收尾总结 + 建议。
 *
 * 这是**固定模板**而非自由 ReAct：流程由代码确定，LLM 只在两处做受限判断
 * （判严重性 / 出总结），故鲁棒、可预测、步数有界——契合 per-PR 子 agent 的设计。
 * 纯逻辑：工具分发（runTool）与 LLM 通道（chat）由调用方注入，便于单测与复用。
 */

export interface ToolText {
  text: string;
  usage?: TokenUsage;
}

export interface ReviewOrchestratorDeps {
  /** 分发一个只读 pr-agent 工具，返回文本结果（描述 / findings / 回答）。 */
  runTool(call: {
    tool: 'describe' | 'review' | 'ask';
    question?: string;
  }): Promise<ToolText>;
  /** 经独立 LLM 通道做一次受限对话（判严重性 / 出总结）。 */
  chat(input: { system: string; user: string }): Promise<ToolText>;
  /** 每产生一个编排步骤即回调（持久化 / 流式推送）。 */
  onStep?(step: AgentStep): void | Promise<void>;
}

export interface ReviewOrchestratorInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  matchedRule?: Rule | null;
  language?: string;
  /** 注入提示词的工具目录（含修改红线标注，见 buildToolCatalog）。 */
  toolCatalog?: ToolCatalogEntry[];
  /** 条件性追问 /ask 的硬上限（默认 2）。 */
  maxFollowupAsks?: number;
  /** 总结严格篇幅上限（默认 800 字符）。 */
  summaryMaxChars?: number;
}

export interface ReviewOrchestratorResult {
  steps: AgentStep[];
  summary: string;
  recommendation: AgentRecommendation;
  tokenUsage: TokenUsage;
  terminationReason?: string;
}

const VERDICTS: readonly AgentRecommendationVerdict[] = ['approve', 'needs_work', 'manual_review'];
function isVerdict(v: unknown): v is AgentRecommendationVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

function addUsage(acc: TokenUsage, u?: TokenUsage): TokenUsage {
  if (!u) return acc;
  return {
    promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
    completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
    totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
    calls: (acc.calls ?? 0) + (u.calls ?? 1),
  };
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** 从 LLM 文本里抽第一个 JSON 对象（容 ```json``` 围栏 + 裸文本），失败返回 null。 */
export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fence?.[1], text]) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1)) as T;
      } catch {
        /* 试下一个候选 */
      }
    }
  }
  return null;
}

function judgePrompt(reviewText: string, maxAsks: number): string {
  return [
    'You just produced the review findings below. Decide whether any finding is a',
    '*particularly severe* issue (e.g. likely security hole, data loss, serious logic bug)',
    `that genuinely needs a clarifying follow-up question. Default to NO follow-up.`,
    `Ask at most ${String(maxAsks)} questions, and only for severe issues.`,
    '',
    'Reply with JSON only: {"severe": boolean, "questions": string[]}.',
    '',
    '--- Review findings ---',
    reviewText,
  ].join('\n');
}

function summaryPrompt(
  describeText: string,
  reviewText: string,
  askResults: string[],
  maxChars: number,
): string {
  return [
    'Write a STRICTLY short closing summary of this pre-review for the human reviewer',
    `(at most ${String(maxChars)} characters; compress, do not truncate key points).`,
    'Include the key points, risks, and a non-binding recommendation.',
    'Format for readability: use newlines (\\n) to separate sections; lead with the core change,',
    'then list each key risk on its own line prefixed with "- ". Keep lines short.',
    '',
    'Reply with JSON only:',
    '{"summary": string, "recommendation": {"verdict": "approve"|"needs_work"|"manual_review", "reason": string}}',
    '',
    '--- Description ---',
    describeText,
    '',
    '--- Review findings ---',
    reviewText,
    ...(askResults.length ? ['', '--- Follow-up Q&A ---', askResults.join('\n\n')] : []),
  ].join('\n');
}

/**
 * 跑一次评审微流程。只用只读工具（describe/review/ask），不触碰修改类操作（红线见设计
 * 「工具修改红线」，由分发层 + 交互式编排另行把关）。
 */
export async function runReviewMicroflow(
  deps: ReviewOrchestratorDeps,
  input: ReviewOrchestratorInput,
): Promise<ReviewOrchestratorResult> {
  const maxAsks = input.maxFollowupAsks ?? 2;
  const summaryMax = input.summaryMaxChars ?? 800;
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};

  const record = async (step: AgentStep): Promise<void> => {
    steps.push(step);
    await deps.onStep?.(step);
  };

  // base system context（工具目录留空：微流程不暴露自由工具选择）
  const system = assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog ?? [],
    matchedRule: input.matchedRule,
    language: input.language,
  });

  // 1. describe + review（固定两步，并行——彼此独立、都只读 PR，无先后依赖；
  //    实际并发度受运行队列 max_concurrency 约束，串行执行时结果同样正确）。
  //    错开 100~200ms 起跑，避免两个工具同一瞬间齐发。
  const [describe, review] = await runStaggered(
    [{ tool: 'describe' as const }, { tool: 'review' as const }],
    (c) => deps.runTool(c),
  );
  usage = addUsage(usage, describe.usage);
  await record({ kind: 'tool', toolCall: { tool: '/describe' }, result: clamp(describe.text, 400) });
  usage = addUsage(usage, review.usage);
  await record({ kind: 'tool', toolCall: { tool: '/review' }, result: clamp(review.text, 400) });

  // 2. 仅严重问题条件性追问
  const judge = await deps.chat({ system, user: judgePrompt(review.text, maxAsks) });
  usage = addUsage(usage, judge.usage);
  const verdict = extractJson<{ severe?: boolean; questions?: string[] }>(judge.text);
  const questions = verdict?.severe ? (verdict.questions ?? []).slice(0, maxAsks) : [];
  await record({
    kind: 'judge',
    thought: '判断是否存在需追问的严重问题',
    result: questions.length ? `严重，追问 ${String(questions.length)} 个` : '无严重问题，不追问',
  });

  const askResults: string[] = [];
  for (const q of questions) {
    const ask = await deps.runTool({ tool: 'ask', question: q });
    usage = addUsage(usage, ask.usage);
    askResults.push(`Q: ${q}\nA: ${ask.text}`);
    await record({
      kind: 'tool',
      toolCall: { tool: '/ask', args: { question: q } },
      result: clamp(ask.text, 300),
    });
  }

  // 3. 收尾总结 + 建议
  const sum = await deps.chat({
    system,
    user: summaryPrompt(describe.text, review.text, askResults, summaryMax),
  });
  usage = addUsage(usage, sum.usage);
  const parsed = extractJson<{
    summary?: string;
    recommendation?: { verdict?: unknown; reason?: unknown };
  }>(sum.text);
  const summary = clamp(parsed?.summary ?? sum.text, summaryMax);
  const recommendation: AgentRecommendation =
    parsed?.recommendation && isVerdict(parsed.recommendation.verdict)
      ? {
          verdict: parsed.recommendation.verdict,
          reason:
            typeof parsed.recommendation.reason === 'string' ? parsed.recommendation.reason : '',
        }
      : { verdict: 'manual_review', reason: '无法解析建议，转人工复核' };
  await record({ kind: 'plan', thought: '收尾总结', result: summary });

  return { steps, summary, recommendation, tokenUsage: usage };
}
