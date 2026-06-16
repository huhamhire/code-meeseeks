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

/** 把 JSON 串字面量内部未转义的裸控制符（换行/回车/制表）补转义。LLM 常把多行 markdown 原样塞进
 *  字符串值而不转义换行，使 JSON.parse 失败——这一步修复该常见错误（不改字符串外的结构）。 */
function escapeRawControlInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      inStr = !inStr;
      out += ch;
    } else if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
    } else {
      out += ch;
    }
  }
  return out;
}

/** 从 LLM 文本里抽第一个 JSON 对象（容 ```json``` 围栏 + 裸文本），失败返回 null。
 *  对每个候选先按原样解析，失败再补转义裸换行重试，兜住模型多行字符串不转义的常见情况。 */
export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const c of [fence?.[1], text]) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    const slice = c.slice(start, end + 1);
    for (const candidate of [slice, escapeRawControlInStrings(slice)]) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        /* 试下一个候选 / 下一种转义 */
      }
    }
  }
  return null;
}

/**
 * 去掉模型误并入 summary / final 末尾的判定 JSON（```json {...}``` 围栏或裸对象，仅当含
 * recommendation/verdict 字样才删），避免原始 JSON 暴露给用户。recommendation 走独立字段渲染为判定徽标。
 */
export function stripTrailingJson(s: string): string {
  let out = s.trimEnd();
  // 末尾围栏代码块（```json {...}```）
  out = out
    .replace(/\s*```(?:json)?\s*\{[\s\S]*?\}\s*```\s*$/i, (m) =>
      /"(?:recommendation|verdict)"\s*:/.test(m) ? '' : m,
    )
    .trimEnd();
  // 末尾裸 JSON 对象：以末尾 } 为锚按花括号配平反找到匹配的起始 {，界定整个尾部对象（非最内层 {）。
  if (out.endsWith('}')) {
    let depth = 0;
    let start = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const ch = out[i];
      if (ch === '}') depth++;
      else if (ch === '{' && --depth === 0) {
        start = i;
        break;
      }
    }
    if (start >= 0 && /"(?:recommendation|verdict)"\s*:/.test(out.slice(start))) {
      out = out.slice(0, start).trimEnd();
    }
  }
  return out;
}

/**
 * 兜底打捞人类可读散文：当 JSON 动作解析失败（截断 / 引号未转义等无法恢复时），从原始文本里用宽松
 * 正则捞出 `final` / `summary` 字段值并反转义，绝不把原始 JSON 动作丢给用户当回答。捞不到才退回原文。
 */
export function salvageProse(raw: string): string {
  const m = raw.match(/"(?:final|summary)"\s*:\s*"((?:\\.|[^"\\])*)"?/);
  if (m?.[1]) {
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  return raw.trim();
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

/** 评审总结的统一三段式骨架标题（按语言本地化，缺省回落英文）：固定结构 → 输出稳定、可预期。
 *  顺序固定为 概述 / 关键发现 / 建议。 */
const SUMMARY_SECTIONS: Record<string, readonly [string, string, string]> = {
  'zh-CN': ['摘要', '关键发现', '建议'],
  'en-US': ['Summary', 'Key findings', 'Suggestions'],
  'ja-JP': ['概要', '主な指摘', '提案'],
  'de-DE': ['Zusammenfassung', 'Wichtige Erkenntnisse', 'Empfehlungen'],
};
export function summarySections(language?: string): readonly [string, string, string] {
  return SUMMARY_SECTIONS[language ?? 'en-US'] ?? SUMMARY_SECTIONS['en-US']!;
}

function summaryPrompt(
  describeText: string,
  reviewText: string,
  askResults: string[],
  maxChars: number,
  sections: readonly [string, string, string],
): string {
  const [overview, findings, suggestions] = sections;
  return [
    'Write a closing review summary for the human reviewer, in the SAME LANGUAGE as the review findings',
    `(at most ${String(maxChars)} characters; compress, never truncate key points).`,
    'Use EXACTLY this markdown skeleton — these three "## " sections, in this order, and nothing else.',
    'Keep each line short; put every finding / suggestion on its own "- " bullet:',
    '',
    `## ${overview}`,
    '<one short paragraph: the core change and overall risk level>',
    `## ${findings}`,
    '<each key finding or risk on its own "- " bullet; if genuinely none, write a single line saying so>',
    `## ${suggestions}`,
    '<each actionable suggestion on its own "- " bullet>',
    '',
    'Put that markdown (with literal \\n newlines) into "summary"; give a separate non-binding recommendation.',
    'NEVER repeat the recommendation / verdict inside "summary" itself (no trailing JSON block) — it goes',
    'ONLY in the separate "recommendation" field.',
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
    const stamped = { ...step, at: step.at ?? new Date().toISOString() };
    steps.push(stamped);
    await deps.onStep?.(stamped);
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
  //    类 Claude Code：先把所选步骤作为一步流式出去（思考在前），工具执行的进度 / 计时由 run 卡片承载，
  //    不再为每个工具补记 tool 步，避免决策被堆到结果之后。
  await record({
    kind: 'plan',
    thought: '生成 PR 描述与审查发现',
    toolCall: { tool: 'describe、review' },
  });
  const [describe, review] = await runStaggered(
    [{ tool: 'describe' as const }, { tool: 'review' as const }],
    (c) => deps.runTool(c),
  );
  usage = addUsage(usage, describe.usage);
  usage = addUsage(usage, review.usage);

  // 2. 仅严重问题条件性追问
  const judgeStart = Date.now();
  const judge = await deps.chat({ system, user: judgePrompt(review.text, maxAsks) });
  const judgeMs = Date.now() - judgeStart;
  usage = addUsage(usage, judge.usage);
  const verdict = extractJson<{ severe?: boolean; questions?: string[] }>(judge.text);
  const questions = verdict?.severe ? (verdict.questions ?? []).slice(0, maxAsks) : [];
  await record({
    kind: 'judge',
    thought: '判断是否存在需追问的严重问题',
    result: questions.length ? `严重，追问 ${String(questions.length)} 个` : '无严重问题，不追问',
    thinkMs: judgeMs,
  });

  const askResults: string[] = [];
  for (const q of questions) {
    const ask = await deps.runTool({ tool: 'ask', question: q });
    usage = addUsage(usage, ask.usage);
    askResults.push(`Q: ${q}\nA: ${ask.text}`);
  }

  // 3. 收尾总结 + 建议
  const sumStart = Date.now();
  const sum = await deps.chat({
    system,
    user: summaryPrompt(
      describe.text,
      review.text,
      askResults,
      summaryMax,
      summarySections(input.language),
    ),
  });
  const sumMs = Date.now() - sumStart;
  usage = addUsage(usage, sum.usage);
  const parsed = extractJson<{
    summary?: string;
    recommendation?: { verdict?: unknown; reason?: unknown };
  }>(sum.text);
  // 解析失败兜底：从原始文本捞 summary 散文；再剥掉模型误并入末尾的判定 JSON，绝不把原始 JSON 展示给用户。
  const summary = clamp(stripTrailingJson(parsed?.summary ?? salvageProse(sum.text)), summaryMax);
  const recommendation: AgentRecommendation =
    parsed?.recommendation && isVerdict(parsed.recommendation.verdict)
      ? {
          verdict: parsed.recommendation.verdict,
          reason:
            typeof parsed.recommendation.reason === 'string' ? parsed.recommendation.reason : '',
        }
      : { verdict: 'manual_review', reason: '无法解析建议，转人工复核' };
  await record({
    kind: 'plan',
    thought: '综合描述与审查发现，生成评审总结',
    result: summary,
    thinkMs: sumMs,
  });

  return { steps, summary, recommendation, tokenUsage: usage };
}
