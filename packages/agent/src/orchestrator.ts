import type { Rule } from '@meebox/rules';
import type { AgentRecommendation, AgentStep, TokenUsage, ToolCatalogEntry } from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import { createStepRecorder } from './steps/context.js';
import { REVIEW_STEPS, type ReviewStepCtx } from './steps/review/index.js';
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
  /** 经独立 LLM 通道做一次受限对话（判严重性 / 出总结）。maxOutputTokens 可给轻量路由判读封顶输出。 */
  chat(input: { system: string; user: string; maxOutputTokens?: number }): Promise<ToolText>;
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
  /** 微流程「生成 PR 描述」步思考。 */
  describe: string;
  /** 微流程「生成代码评审发现」步思考。 */
  review: string;
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
    describe: '生成 PR 描述',
    review: '生成代码评审发现',
    judge: '判断是否存在需追问的严重问题',
    judgeSevere: (n) => `严重，追问 ${String(n)} 个`,
    judgeNone: '无严重问题，不追问',
    summary: '综合描述与审查发现，生成评审总结',
    parseFail: '无法解析建议，转人工复核',
    rejectedPrefix: '拒绝：',
  },
  'en-US': {
    describe: 'Generate the PR description',
    review: 'Generate the code review findings',
    judge: 'Decide whether there are severe issues needing follow-up',
    judgeSevere: (n) => `Severe — ${String(n)} follow-up question${n === 1 ? '' : 's'}`,
    judgeNone: 'No severe issues — no follow-up',
    summary: 'Synthesize the description and findings into a review summary',
    parseFail: 'Could not parse a recommendation — routing to manual review',
    rejectedPrefix: 'Rejected: ',
  },
  'ja-JP': {
    describe: 'PR の説明を生成',
    review: 'コードレビュー指摘を生成',
    judge: '追加質問が必要な重大な問題があるか判断',
    judgeSevere: (n) => `重大、追加質問 ${String(n)} 件`,
    judgeNone: '重大な問題なし、追加質問なし',
    summary: '説明とレビュー指摘を統合してレビュー要約を生成',
    parseFail: '提案を解析できないため、手動レビューに回します',
    rejectedPrefix: '却下：',
  },
  'de-DE': {
    describe: 'PR-Beschreibung erstellen',
    review: 'Code-Review-Befunde erstellen',
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

/**
 * 跑一次评审微流程：describe → review →（仅严重问题）条件追问 ≤N → 收尾总结 + 建议。只用只读工具
 * （describe/review/ask），不碰修改类操作。驱动顺序跑 REVIEW_STEPS、与各步共享 StepRecorder。
 */
export async function runReviewMicroflow(
  deps: ReviewOrchestratorDeps,
  input: ReviewOrchestratorInput,
): Promise<ReviewOrchestratorResult> {
  const labels = stepLabels(input.language);
  const rec = createStepRecorder(deps.onStep);
  const checkAbort = (): void => {
    if (deps.signal?.aborted) throw new Error('用户暂停');
  };
  // base system context（工具目录留空：微流程不暴露自由工具选择）。
  const system = assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog ?? [],
    matchedRule: input.matchedRule,
    language: input.language,
  });
  const ctx: ReviewStepCtx = {
    deps,
    input,
    rec,
    checkAbort,
    maxAsks: input.maxFollowupAsks ?? 2,
    summaryMax: input.summaryMaxChars ?? 800,
    labels,
    system,
    bag: { questions: [], askResults: [] },
  };

  for (const step of REVIEW_STEPS) await step.run(ctx);

  return {
    steps: rec.steps,
    summary: ctx.bag.summary ?? '',
    recommendation: ctx.bag.recommendation ?? { verdict: 'manual_review', reason: labels.parseFail },
    tokenUsage: rec.usage,
  };
}
