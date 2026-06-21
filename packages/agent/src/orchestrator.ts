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
  runTool(call: { tool: 'describe' | 'review' | 'ask'; question?: string }): Promise<ToolText>;
  /** 经独立 LLM 通道做一次受限对话（判严重性 / 出总结）。 */
  chat(input: { system: string; user: string }): Promise<ToolText>;
  /** 每产生一个编排步骤即回调（持久化 / 流式推送）。 */
  onStep?(step: AgentStep): void | Promise<void>;
  /** 用户停止：每步边界检查，已 abort 即抛 `用户暂停` 中止微流程（思考阶段也能立即终止）。 */
  signal?: AbortSignal;
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
  /** 总结篇幅的**参考**上限（默认 800 字符）：仅作提示词里的软约束引导 LLM 收敛，**不**对产出做硬截断。 */
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

/** 追问判断用的精简系统提示：不带 agent 完整上下文（SOUL / 记忆 / 用户档 / 工具目录 / 规则 / PR 元数据）。
 *  这是一次轻量路由判读，仅凭 describe + review 结果判「是否有严重问题需追问」，与 AutoPilot 初判
 *  （judgeAutopilotBatch）同思路——砍掉无关前缀大幅降输入 token、提速；产物只是结构化布尔 + 问题列表。 */
const JUDGE_SYSTEM =
  'You are a senior code reviewer triaging review findings for follow-up. Be decisive and terse; reply with JSON only, no reasoning.';

function judgePrompt(describeText: string, reviewText: string, maxAsks: number): string {
  return [
    'You just produced the PR description and review findings below. Decide whether any finding is a',
    '*particularly severe* issue (e.g. likely security hole, data loss, serious logic bug)',
    `that genuinely needs a clarifying follow-up question. Default to NO follow-up.`,
    `Ask at most ${String(maxAsks)} questions, and only for severe issues.`,
    '',
    'Reply with JSON only: {"severe": boolean, "questions": string[]}. No explanation, no reasoning.',
    '',
    '--- PR description ---',
    describeText,
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

/**
 * 编排 / 规划步骤行里**直接展示**给用户的固定文案（thought / 判读结果 / 兜底建议理由 / 拒绝前缀）。
 * 这些串经 transcript 持久化、由渲染层逐字显示（不走 i18next key 映射），故必须在生成时按会话语言
 * （input.language）落地、缺省回落英文——与 summarySections 同策略。LLM 生成的自由 thought 本就跟随
 * 作答语言，不在此列。事后切 UI 语言不回改历史步骤（同总结正文）。
 */
export interface AgentStepLabels {
  /** 微流程首步（describe + review）思考。 */
  describeReview: string;
  /** 微流程判读步思考。 */
  judge: string;
  /** 判读结果：存在严重问题、将追问 n 个。 */
  judgeSevere: (n: number) => string;
  /** 判读结果：无严重问题、不追问。 */
  judgeNone: string;
  /** 收尾步思考。 */
  summary: string;
  /** 收尾建议解析失败、转人工复核的兜底理由。 */
  parseFail: string;
  /** 规划步：工具调用被红线拒绝的结果前缀（后接具体原因）。 */
  rejectedPrefix: string;
}
const STEP_LABELS: Record<string, AgentStepLabels> = {
  'zh-CN': {
    describeReview: '生成 PR 描述与审查发现',
    judge: '判断是否存在需追问的严重问题',
    judgeSevere: (n) => `严重，追问 ${String(n)} 个`,
    judgeNone: '无严重问题，不追问',
    summary: '综合描述与审查发现，生成评审总结',
    parseFail: '无法解析建议，转人工复核',
    rejectedPrefix: '拒绝：',
  },
  'en-US': {
    describeReview: 'Generate the PR description and review findings',
    judge: 'Decide whether there are severe issues needing follow-up',
    judgeSevere: (n) => `Severe — ${String(n)} follow-up question${n === 1 ? '' : 's'}`,
    judgeNone: 'No severe issues — no follow-up',
    summary: 'Synthesize the description and findings into a review summary',
    parseFail: 'Could not parse a recommendation — routing to manual review',
    rejectedPrefix: 'Rejected: ',
  },
  'ja-JP': {
    describeReview: 'PR の説明とレビュー指摘を生成',
    judge: '追加質問が必要な重大な問題があるか判断',
    judgeSevere: (n) => `重大、追加質問 ${String(n)} 件`,
    judgeNone: '重大な問題なし、追加質問なし',
    summary: '説明とレビュー指摘を統合してレビュー要約を生成',
    parseFail: '提案を解析できないため、手動レビューに回します',
    rejectedPrefix: '却下：',
  },
  'de-DE': {
    describeReview: 'PR-Beschreibung und Review-Befunde erstellen',
    judge: 'Entscheiden, ob schwerwiegende Probleme eine Rückfrage erfordern',
    judgeSevere: (n) => `Schwerwiegend — ${String(n)} Rückfrage${n === 1 ? '' : 'n'}`,
    judgeNone: 'Keine schwerwiegenden Probleme — keine Rückfrage',
    summary: 'Beschreibung und Befunde zu einer Review-Zusammenfassung zusammenfassen',
    parseFail: 'Empfehlung konnte nicht geparst werden — manuelle Prüfung',
    rejectedPrefix: 'Abgelehnt: ',
  },
};
export function stepLabels(language?: string): AgentStepLabels {
  return STEP_LABELS[language ?? 'en-US'] ?? STEP_LABELS['en-US']!;
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
    `(aim for roughly ${String(maxChars)} characters — compress and prioritize; this is a soft guideline, not a hard limit, so do NOT truncate key points to fit).`,
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
  const labels = stepLabels(input.language);
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};

  const record = async (step: AgentStep): Promise<void> => {
    const stamped = { ...step, at: step.at ?? new Date().toISOString() };
    steps.push(stamped);
    await deps.onStep?.(stamped);
  };

  // 用户停止：每个步骤边界检查，已 abort 即抛 `用户暂停`（思考阶段也能立即中止，不必等当前工具跑完）。
  const checkAbort = (): void => {
    if (deps.signal?.aborted) throw new Error('用户暂停');
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
  checkAbort();
  await record({
    kind: 'plan',
    thought: labels.describeReview,
    toolCall: { tool: 'describe + review' },
  });
  const [describe, review] = await runStaggered(
    [{ tool: 'describe' as const }, { tool: 'review' as const }],
    (c) => deps.runTool(c),
  );
  usage = addUsage(usage, describe.usage);
  usage = addUsage(usage, review.usage);

  // 2. 仅严重问题条件性追问
  checkAbort();
  const judgeStart = Date.now();
  const judge = await deps.chat({
    system: JUDGE_SYSTEM,
    user: judgePrompt(describe.text, review.text, maxAsks),
  });
  const judgeMs = Date.now() - judgeStart;
  usage = addUsage(usage, judge.usage);
  const verdict = extractJson<{ severe?: boolean; questions?: string[] }>(judge.text);
  const questions = verdict?.severe ? (verdict.questions ?? []).slice(0, maxAsks) : [];
  await record({
    kind: 'judge',
    thought: labels.judge,
    result: questions.length ? labels.judgeSevere(questions.length) : labels.judgeNone,
    thinkMs: judgeMs,
    usage: judge.usage,
  });

  // 多个追问同属一个阶段、彼此独立（各自只读 PR、互不依赖），故并行派发——与上面 describe + review
  // 同模式：runStaggered 保序（askResults 与 questions 一一对应）、错开 100~200ms 起跑，实际并发度仍受
  // 运行队列 max_concurrency 兜底。questions 为空时不触发任何调用。
  checkAbort();
  const asks = questions.length
    ? await runStaggered(questions, (q) => deps.runTool({ tool: 'ask', question: q }))
    : [];
  const askResults = asks.map((ask, i) => {
    usage = addUsage(usage, ask.usage);
    return `Q: ${questions[i]}\nA: ${ask.text}`;
  });

  // 3. 收尾总结 + 建议
  checkAbort();
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
  // **不做硬截断**：篇幅只在提示词里作参考性约束（summaryMax，见 summaryPrompt），AI 已生成的总结完整保留，
  // 避免「参数…」这种半句被切断。
  const summary = stripTrailingJson(parsed?.summary ?? salvageProse(sum.text)).trim();
  const recommendation: AgentRecommendation =
    parsed?.recommendation && isVerdict(parsed.recommendation.verdict)
      ? {
          verdict: parsed.recommendation.verdict,
          reason:
            typeof parsed.recommendation.reason === 'string' ? parsed.recommendation.reason : '',
        }
      : { verdict: 'manual_review', reason: labels.parseFail };
  await record({
    kind: 'plan',
    thought: labels.summary,
    result: summary,
    thinkMs: sumMs,
    usage: sum.usage,
  });

  return { steps, summary, recommendation, tokenUsage: usage };
}
