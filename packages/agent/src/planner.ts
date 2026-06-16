import type { Rule } from '@meebox/rules';
import type {
  AgentMessage,
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentStep,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import { extractJson, salvageProse, stripTrailingJson, summarySections } from './orchestrator.js';
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
  /**
   * 既往多轮对话（用户 / 助手消息，按时间升序，不含本轮请求）。注入规划 LLM 的上下文，使
   * Agent 跨轮记住此前交流；**绝不**透传给 pr-agent 工具（工具只看 PR + 当轮问题）。
   */
  history?: AgentMessage[];
  /** 步数上限（默认 8）。 */
  maxSteps?: number;
}

export interface PlanningResult {
  steps: AgentStep[];
  finalText: string;
  tokenUsage: TokenUsage;
  /** 收尾建议（仅评审类请求；非约束性）。供 UI 展示判定徽标，与 AutoPilot / 微流程一致。 */
  recommendation?: AgentRecommendation;
  /** 本轮主动记下、待持久化到各可写文件的非隐私条目（去重后写盘由上层处理）。 */
  memories: AgentMemoryNotes;
  terminationReason?: string;
}

interface PlannerAction {
  thought?: string;
  tool?: string;
  /**
   * 一次并行多选只读工具（如 describe + review，或多个 /ask）；与 tool 二选一，tools 优先。
   * 元素可为工具名字符串，或 `{tool, question}` 对象——后者让一轮里并行派发多个带问题的 /ask。
   */
  tools?: Array<string | { tool?: string; question?: string }>;
  question?: string;
  final?: string;
  /** 评审类收尾的非约束性判定建议（verdict + 理由）；非评审请求省略。 */
  recommendation?: { verdict?: unknown; reason?: unknown };
  /**
   * 主动记下的**非隐私**条目，按目标可写文件分组：user→USER.md（用户信息），memory→MEMORY.md
   * （长期知识），agents→AGENTS.md（工作规范，仅追加）。SOUL.md 永不写。
   */
  remember?: { user?: unknown; memory?: unknown; agents?: unknown };
}

/** Agent 主动记忆，按目标可写文件分组（键与 WritableAgentFile 对齐）。 */
export interface AgentMemoryNotes {
  user: string[];
  memory: string[];
  agents: string[];
}

function emptyMemoryNotes(): AgentMemoryNotes {
  return { user: [], memory: [], agents: [] };
}

function toNoteList(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  }
  return [];
}

/** 把一个动作里的 remember 累加进 acc（容错；非对象忽略）。 */
function accumulateRemember(value: PlannerAction['remember'], acc: AgentMemoryNotes): void {
  if (!value || typeof value !== 'object') return;
  acc.user.push(...toNoteList(value.user));
  acc.memory.push(...toNoteList(value.memory));
  acc.agents.push(...toNoteList(value.agents));
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

/**
 * 注入规划上下文的历史对话预算：单条字符上限 + 总字符预算（从最新往回累计、超预算即裁剪更早的）。
 * 约定会话上下文不超过 LLM 上下文窗口的一半——以字符近似 token 做保守封顶：64k 字符 ≈ 16~40k token
 * （视中英文占比），对应约 32k~64k token 半窗的目标量级。后续可按模型实际窗口精确估算 token，并引入
 * 老消息压缩（摘要）替代直接裁剪。
 */
const HISTORY_MESSAGE_MAX = 2000;
const HISTORY_BUDGET_CHARS = 64000;

/** 取最近若干轮、各自限长，并按总预算从新到旧裁剪（丢弃超预算的更早消息），返回时间升序文本。 */
function buildConversationContext(history: readonly AgentMessage[]): string {
  const lines: string[] = [];
  let budget = HISTORY_BUDGET_CHARS;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${clamp(m.content, HISTORY_MESSAGE_MAX)}`;
    if (line.length + 1 > budget) break; // 预算耗尽：更早的对话整体裁掉
    budget -= line.length + 1;
    lines.push(line);
  }
  return lines.reverse().join('\n');
}

function buildProtocol(sections: readonly [string, string, string]): string {
  const [overview, findings, suggestions] = sections;
  return [
    'Each turn, reply with JSON ONLY for the next action:',
    '- One tool:   {"thought": "...", "tool": "/review", "question": "<only for /ask>"}',
    '- Several read-only tools AT ONCE (run in parallel, at most 3): {"thought": "...", "tools": ["/describe", "/review"]}',
    '- Several /ask at once (parallel): {"thought": "...", "tools": [{"tool": "/ask", "question": "Q1"}, {"tool": "/ask", "question": "Q2"}]}',
    '- Finish:     {"thought": "...", "final": "<your answer to the user>"}',
    'Only call tools listed under "Available tools" that are NOT disabled. Prefer few precise steps,',
    'but when the request needs multiple independent read-only tools (e.g. summary AND review, or several',
    'distinct questions), call them together via "tools" so they run in parallel instead of one per turn.',
    'In "tools" each element is either a tool name (e.g. "/review") or, for /ask, an object',
    '{"tool": "/ask", "question": "..."} — use the object form to fire several /ask questions concurrently.',
    'Closing a CODE REVIEW: when your final answer reviews this PR, you MUST follow this fixed shape —',
    `format "final" as markdown with these sections in order: "## ${overview}" (PR summary), "## ${findings}"`,
    `(must-fix / concerns as a bulleted list, empty-safe), "## ${suggestions}" (next steps); AND include a`,
    '"recommendation" object: {"verdict": "approve"|"needs_work"|"manual_review", "reason": "<one line>"}.',
    'verdict is non-binding (no write action). Omit "recommendation" for non-review answers.',
    'NEVER repeat the recommendation / verdict inside "final" itself (no trailing JSON block) — it goes',
    'ONLY in the separate "recommendation" field.',
    'Memory: persisting is RARE and OPT-IN. Most turns have NOTHING to remember — then OMIT "remember"',
    'entirely. Use a "remember" object only for a fact that will matter ACROSS MANY FUTURE, UNRELATED',
    'reviews, grouped by target file (short notes in the user\'s language):',
    '  {"remember": {"user": ["称呼: Kyle"], "memory": ["repo uses g-<id> for gray apps"], "agents": ["..."]}}',
    '- user   → the person you talk to: preferred 称呼, language, lasting review/working preferences.',
    '- memory → durable PROJECT facts (stable architecture / conventions / IDs that outlive any one PR).',
    '- agents → general working norms you should always follow (e.g. reply language, review order).',
    'HARD BAR — do NOT record findings or heuristics tied to THIS PR or a specific feature / module /',
    'symbol: e.g. "评审涉及 X 时重点核对 Y", "注意 fn() 对数字 ID 误判". Those are this review\'s OUTPUT,',
    'not durable rules — putting them in agents/memory pollutes future behavior. If a note names a specific',
    'function / field / feature / scenario, it is a finding, NOT a memory — keep it in the review, omit here.',
    'When in doubt, do NOT record. Over a whole session you should rarely write more than a note or two.',
    'NEVER record private or sensitive data: real identity beyond a chosen 称呼, email / phone / address,',
    'employer-confidential specifics, secrets / tokens. When unsure whether something is private, do NOT record.',
    'Conversation & scope:',
    '- Natural conversation is fine: greet, say who you are, ask a clarifying question — answer directly',
    '  in "final" without calling tools.',
    '- Your domain is reviewing THIS PR (describing it, reviewing its changes, answering questions about',
    '  them). Politely DECLINE in "final" any task OUTSIDE that domain (unrelated coding, general/off-topic',
    '  requests) — do NOT call tools for it.',
    '- For a PR-related request with no clearly fitting tool, default to /ask with a focused question.',
  ].join('\n');
}

export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const steps: AgentStep[] = [];
  let usage: TokenUsage = {};
  const history: string[] = [];
  const memories = emptyMemoryNotes();

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRule: input.matchedRule,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${buildProtocol(summarySections(input.language))}`;

  const record = async (step: AgentStep): Promise<void> => {
    const stamped = { ...step, at: step.at ?? new Date().toISOString() };
    steps.push(stamped);
    await deps.onStep?.(stamped);
  };

  // 既往多轮对话注入规划上下文（按预算裁剪），让 Agent 跨轮记住交流；仅供规划 LLM 参考，
  // 绝不透传给 pr-agent 工具。
  const convo = buildConversationContext(input.history ?? []);

  for (let i = 0; i < maxSteps; i++) {
    if (deps.signal?.aborted) {
      return { steps, finalText: '', tokenUsage: usage, memories, terminationReason: '用户暂停' };
    }

    const user = [
      convo
        ? `Conversation so far (your context only — NEVER pass any of it to tools):\n${convo}\n`
        : '',
      `User request: ${input.userRequest}`,
      history.length ? `\nProgress so far:\n${history.join('\n')}` : '',
      '\nReply with the next JSON action.',
    ]
      .filter(Boolean)
      .join('\n');

    // 计本轮 LLM 推理耗时（单步思考时长，类 Claude Code 的「Thought for Ns」），系到该决策步上。
    const thinkStart = Date.now();
    const r = await deps.chat({ system, user });
    const thinkMs = Date.now() - thinkStart;
    // 思考刚结束就发现已被停止 → 立即收尾，不再据此动作分发工具（停止在思考阶段也即时生效）。
    if (deps.signal?.aborted) {
      return { steps, finalText: '', tokenUsage: usage, memories, terminationReason: '用户暂停' };
    }
    usage = addUsage(usage, r.usage);
    const action = extractJson<PlannerAction>(r.text);
    // 累加本动作携带的记忆（任何动作都可附 remember）。
    accumulateRemember(action?.remember, memories);

    const hasCalls = Boolean(action?.tool) || Boolean(action?.tools?.length);

    // 无法解析 / 既无 tool(s) 又无 final → 当作收尾。兜底从原始文本打捞散文，绝不把原始 JSON 动作丢给用户。
    if (!action || (!hasCalls && !action.final)) {
      const finalText = action?.final ?? salvageProse(r.text);
      await record({ kind: 'plan', thought: action?.thought, result: finalText, thinkMs });
      return { steps, finalText, tokenUsage: usage, memories };
    }

    if (action.final && !hasCalls) {
      // 剥掉模型误并入 final 末尾的判定 JSON（recommendation 走独立字段渲染为判定徽标）。
      const finalText = stripTrailingJson(action.final);
      await record({ kind: 'plan', thought: action.thought, result: finalText, thinkMs });
      return {
        steps,
        finalText,
        tokenUsage: usage,
        recommendation: parseRecommendation(action.recommendation),
        memories,
      };
    }

    // 归一为待执行工具列表：tools 多选（并行、只读）优先——元素可为工具名或 {tool, question}（多个
    // 带问题的 /ask 也能一轮并行派发）；否则单 tool（可带 question）。
    const requested: Array<{ tool: string; question?: string }> = action.tools?.length
      ? action.tools
          .slice(0, MAX_PARALLEL_TOOLS)
          .map((tl) =>
            typeof tl === 'string'
              ? { tool: tl }
              : { tool: tl.tool ?? '', question: tl.question },
          )
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

    // 类 Claude Code：先把本轮思考与所选步骤作为一步流式出去（思考是工具选择的前因），随后才执行工具。
    // 工具执行的进度 / 计时由 run 卡片承载，这里不再为每个工具补记 tool 步，避免决策被堆到结果之后。
    await record({
      kind: 'plan',
      thought: action.thought,
      toolCall: { tool: allowed.map((c) => c.tool).join('、') },
      thinkMs,
    });

    // 并行分发允许的工具（多选时同时跑，实际并发受运行队列约束）；相互错开 100~200ms 起跑，避免同一瞬间齐发。
    const ran = await runStaggered(allowed, async (c) => ({ c, res: await deps.runTool(c) }));
    for (const { c, res } of ran) {
      usage = addUsage(usage, res.usage);
      history.push(
        `Called ${c.tool}${c.question ? ` ("${c.question}")` : ''} → ${clamp(res.text, 600)}`,
      );
    }
  }

  return { steps, finalText: '', tokenUsage: usage, memories, terminationReason: '步数上限中止' };
}
