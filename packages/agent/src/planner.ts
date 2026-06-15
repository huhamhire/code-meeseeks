import type { Rule } from '@meebox/rules';
import type {
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentStep,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import { extractJson } from './orchestrator.js';
import { runStaggered } from './stagger.js';
import { assertToolAllowed } from './tool-catalog.js';
import type { AgentContext } from './types.js';

/**
 * 自由规划（ReAct）编排器（见 docs/arch/06-agent.md「会话 Agent 化」）：交互式入口的自然
 * 语言请求由它处理——每步 chat 规划下一动作（调工具 / 收尾），解析 JSON 动作，红线硬校验后
 * 分发工具、把结果回喂，循环到 final 或步数上限。与固定微流程（runReviewMicroflow）互补。
 *
 * 纯逻辑：chat / runTool 注入；红线经 assertToolAllowed 落地（修改类未授权即拒、回喂让 LLM 改选）。
 */

export interface PlanningToolResult {
  text: string;
  usage?: TokenUsage;
}

export interface PlanningDeps {
  /** 规划 LLM 调用（单 system + user）。 */
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  /** 分发一个工具，返回文本结果（红线已由编排器先行校验）。 */
  runTool: (call: { tool: string; question?: string }) => Promise<PlanningToolResult>;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** 用户暂停信号；abort 后循环在下一步前停下，返回 terminationReason='用户暂停'。 */
  signal?: AbortSignal;
}

export interface PlanningInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  matchedRule?: Rule | null;
  language?: string;
  /** 用户的自然语言请求。 */
  userRequest: string;
  /** 步数上限（默认 8）。 */
  maxSteps?: number;
}

export interface PlanningResult {
  steps: AgentStep[];
  finalText: string;
  tokenUsage: TokenUsage;
  /** 收尾建议（仅评审类请求；非约束性）。供 UI 展示判定徽标，与 AutoPilot / 微流程一致。 */
  recommendation?: AgentRecommendation;
  terminationReason?: string;
}

interface PlannerAction {
  thought?: string;
  tool?: string;
  /** 一次并行多选只读工具（如 describe + review）；与 tool 二选一，tools 优先。 */
  tools?: string[];
  question?: string;
  final?: string;
  /** 评审类收尾的非约束性判定建议（verdict + 理由）；非评审请求省略。 */
  recommendation?: { verdict?: unknown; reason?: unknown };
}

const VERDICTS: readonly AgentRecommendationVerdict[] = ['approve', 'needs_work', 'manual_review'];

/** 从收尾动作解析出合法 recommendation；verdict 非法 / 缺省 → undefined（不强加判定）。 */
function parseRecommendation(rec?: PlannerAction['recommendation']): AgentRecommendation | undefined {
  if (!rec) return undefined;
  const verdict = rec.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as AgentRecommendationVerdict)) {
    return undefined;
  }
  return {
    verdict: verdict as AgentRecommendationVerdict,
    reason: typeof rec.reason === 'string' ? rec.reason : '',
  };
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

/** 一次并行最多分发的工具数：多选时截断，防止一轮打出过多 pr-agent run。 */
const MAX_PARALLEL_TOOLS = 3;

const PROTOCOL = [
  'Each turn, reply with JSON ONLY for the next action:',
  '- One tool:   {"thought": "...", "tool": "/review", "question": "<only for /ask>"}',
  '- Several read-only tools AT ONCE (run in parallel, at most 3): {"thought": "...", "tools": ["/describe", "/review"]}',
  '- Finish:     {"thought": "...", "final": "<your answer to the user>"}',
  'Only call tools listed under "Available tools" that are NOT disabled. Prefer few precise steps,',
  'but when the request needs multiple independent read-only tools (e.g. summary AND review), call',
  'them together via "tools" so they run in parallel instead of one per turn. Use "tool"+"question"',
  'for /ask (single only).',
  'Closing a CODE REVIEW: when your final answer reviews this PR, you MUST follow this fixed shape —',
  'format "final" as markdown with these sections in order: "## 摘要" (PR summary), "## 关键发现"',
  '(must-fix / concerns as a bulleted list, empty-safe), "## 建议" (next steps); AND include a',
  '"recommendation" object: {"verdict": "approve"|"needs_work"|"manual_review", "reason": "<one line>"}.',
  'verdict is non-binding (no write action). Omit "recommendation" for non-review answers.',
  'Conversation & scope:',
  '- Natural conversation is fine: greet, say who you are, ask a clarifying question — answer directly',
  '  in "final" without calling tools.',
  '- Your domain is reviewing THIS PR (describing it, reviewing its changes, answering questions about',
  '  them). Politely DECLINE in "final" any task OUTSIDE that domain (unrelated coding, general/off-topic',
  '  requests) — do NOT call tools for it.',
  '- For a PR-related request with no clearly fitting tool, default to /ask with a focused question.',
].join('\n');

export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};
  const history: string[] = [];

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRule: input.matchedRule,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${PROTOCOL}`;

  const record = async (step: AgentStep): Promise<void> => {
    steps.push(step);
    await deps.onStep?.(step);
  };

  for (let i = 0; i < maxSteps; i++) {
    if (deps.signal?.aborted) {
      return { steps, finalText: '', tokenUsage: usage, terminationReason: '用户暂停' };
    }

    const user = [
      `User request: ${input.userRequest}`,
      history.length ? `\nProgress so far:\n${history.join('\n')}` : '',
      '\nReply with the next JSON action.',
    ]
      .filter(Boolean)
      .join('\n');

    const r = await deps.chat({ system, user });
    usage = addUsage(usage, r.usage);
    const action = extractJson<PlannerAction>(r.text);

    const hasCalls = Boolean(action?.tool) || Boolean(action?.tools?.length);

    // 无法解析 / 既无 tool(s) 又无 final → 当作收尾（原文兜底）。
    if (!action || (!hasCalls && !action.final)) {
      const finalText = action?.final ?? r.text.trim();
      await record({ kind: 'plan', thought: action?.thought, result: finalText });
      return { steps, finalText, tokenUsage: usage };
    }

    if (action.final && !hasCalls) {
      await record({ kind: 'plan', thought: action.thought, result: action.final });
      return {
        steps,
        finalText: action.final,
        tokenUsage: usage,
        recommendation: parseRecommendation(action.recommendation),
      };
    }

    // 归一为待执行工具列表：tools 多选（并行、只读，无 per-tool question）优先；否则单 tool（可带 question）。
    const requested: Array<{ tool: string; question?: string }> = action.tools?.length
      ? action.tools.slice(0, MAX_PARALLEL_TOOLS).map((tl) => ({ tool: tl }))
      : [{ tool: action.tool ?? '', question: action.question }];

    // 红线硬校验逐个把关：未授权 / 未知即拒并回喂；允许的留待并行执行。
    const allowed: Array<{ tool: string; question?: string }> = [];
    for (const c of requested) {
      try {
        assertToolAllowed(c.tool, input.toolCatalog);
        allowed.push(c);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await record({ kind: 'judge', thought: action.thought, toolCall: { tool: c.tool }, result: `拒绝：${msg}` });
        history.push(`Refused ${c.tool}: ${msg}`);
      }
    }
    if (!allowed.length) continue; // 全被拒 → 回喂后下一轮重选

    // 并行分发允许的工具（多选时同时跑，实际并发受运行队列约束）；相互错开 100~200ms 起跑，
    // 避免同一瞬间齐发。thought 只系在首条，避免重复。
    const ran = await runStaggered(allowed, async (c) => ({ c, res: await deps.runTool(c) }));
    for (let k = 0; k < ran.length; k++) {
      const { c, res } = ran[k]!;
      usage = addUsage(usage, res.usage);
      await record({
        kind: 'tool',
        thought: k === 0 ? action.thought : undefined,
        toolCall: { tool: c.tool, args: c.question ? { question: c.question } : undefined },
        result: clamp(res.text, 400),
      });
      history.push(
        `Called ${c.tool}${c.question ? ` ("${c.question}")` : ''} → ${clamp(res.text, 600)}`,
      );
    }
  }

  return { steps, finalText: '', tokenUsage: usage, terminationReason: '步数上限中止' };
}
