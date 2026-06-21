import type { Rule } from '@meebox/rules';
import type {
  AgentMessage,
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentStep,
  AgentTodoItem,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './assemble.js';
import type { MemoryNote } from './memory.js';
import {
  type AgentStepLabels,
  extractJson,
  salvageProse,
  stepLabels,
  stripTrailingJson,
  summarySections,
} from './orchestrator.js';
import { runStaggered } from './stagger.js';
import { createStepRecorder, type StepRecorder } from './steps/context.js';
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
  /**
   * 取出运行期间排队的用户新消息（中途输入转向）：每轮顶部调用，非空则并入当轮 progress，让 ReAct 据
   * 最新指令与当前进度重排下一步。返回的消息由实现方（主进程）负责持久化到会话（此处只注入、不再落盘）。
   */
  drainPendingInput?: () => Promise<string[]> | string[];
  /**
   * 计划（todo）更新回调：模型每轮给出 / 更新 plan 时调用，由实现方持久化（session.todo）+ 广播刷新。
   * 计划随轮回喂提示、收到新输入时重排——见 buildProtocol 的 plan 约定。
   */
  recordPlan?: (todo: AgentTodoItem[]) => void | Promise<void>;
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
  /**
   * 用户在 Diff 里选中的代码引用（自描述块）。注入当轮规划上下文，让 Agent 知道用户正盯着哪段代码；
   * **绝不**透传给 pr-agent 工具（同 history 约束）。省略 = 本轮无选区引用。
   */
  referencedContext?: string;
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
  /**
   * 计划（todo）：模型可在任意动作里给出 / 更新一份简短步骤清单（标 done、按优先级重排、增删）。
   * 元素可为字符串或 `{id?, text, done?}`。省略 = 计划不变（沿用上一轮）。见 buildProtocol 的 plan 约定。
   */
  plan?: Array<string | { id?: unknown; text?: unknown; done?: unknown }>;
  /** 评审类收尾的非约束性判定建议（verdict + 理由）；非评审请求省略。 */
  recommendation?: { verdict?: unknown; reason?: unknown };
  /**
   * 主动记下的**非隐私**条目，按目标可写文件分组：user→USER.md（用户信息），memory→MEMORY.md
   * （长期知识），agents→AGENTS.md（工作规范，仅追加）。SOUL.md 永不写。
   */
  remember?: { user?: unknown; memory?: unknown; agents?: unknown };
}

/** Agent 主动记忆，按目标可写文件分组（键与 WritableAgentFile 对齐），各条带目标专题章节。 */
export interface AgentMemoryNotes {
  user: MemoryNote[];
  memory: MemoryNote[];
  agents: MemoryNote[];
}

function emptyMemoryNotes(): AgentMemoryNotes {
  return { user: [], memory: [], agents: [] };
}

/**
 * 解析单条记忆：必须是带 `section` + `note` 的对象。无法归入专题章节的条目（纯字符串 / 缺 section）
 * 不是耐久记忆 → 丢弃（返回 null）。
 */
function toNote(raw: unknown): MemoryNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { section?: unknown; note?: unknown };
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  const section = typeof obj.section === 'string' ? obj.section.trim() : '';
  if (!note || !section) return null;
  return { section, note };
}

/** 把目标文件的 remember 数组解析为 MemoryNote[]（容错；丢弃无法归类的条目）。 */
function toNoteList(raw: unknown): MemoryNote[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items.map(toNote).filter((n): n is MemoryNote => n !== null);
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

/** 把模型给出的 plan 归一为 AgentTodoItem[]：容字符串 / 对象，丢空文本；缺 id 按序补。 */
function normalizePlan(raw: PlannerAction['plan']): AgentTodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentTodoItem[] = [];
  raw.forEach((it, i) => {
    if (typeof it === 'string') {
      const text = it.trim();
      if (text) out.push({ id: `s${String(i + 1)}`, text, done: false });
    } else if (it && typeof it === 'object') {
      const text = typeof it.text === 'string' ? it.text.trim() : '';
      if (text) {
        out.push({
          id: typeof it.id === 'string' && it.id ? it.id : `s${String(i + 1)}`,
          text,
          done: it.done === true,
        });
      }
    }
  });
  return out;
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
    'reviews, grouped by target file. Each note is {"section": "<a fitting ## heading>", "note": "<short, in',
    "the user's language>\"}:",
    '  {"remember": {"user": [{"section": "Review preferences", "note": "preferred name: Kyle"}],',
    '                "memory": [{"section": "Project conventions", "note": "repo uses g-<id> for gray apps"}]}}',
    '- "section" is REQUIRED: ABSTRACT the note into a durable, general topic. You are NOT limited to existing',
    '  headings — a target file may have NONE yet (e.g. USER.md starts empty). PREFER reusing a fitting "## ..."',
    '  already in that file (its current content is shown above, match it verbatim); otherwise FREELY introduce a',
    '  new concise topical heading (the section set is meant to grow). Only OMIT a note when it is not a durable,',
    '  generalizable topic at all (a PR-specific finding) — never force such a note in. If a note merely restates',
    '  guidance already present in that section, do NOT record it.',
    '- user   → the person you talk to: preferred name, language, lasting review/working preferences.',
    '- memory → durable PROJECT facts (stable architecture / conventions / IDs that outlive any one PR).',
    '- agents → general working norms you should always follow (e.g. reply language, review order).',
    'HARD BAR — do NOT record findings or heuristics tied to THIS PR or a specific feature / module /',
    'symbol: e.g. "when reviewing X, double-check Y", "note: fn() misjudges numeric IDs". Those are this',
    "review's OUTPUT, not durable rules — putting them in agents/memory pollutes future behavior. If a note",
    'names a specific function / field / feature / scenario, it is a finding, NOT a memory — keep it in the',
    'review, omit here.',
    'When in doubt, do NOT record. Over a whole session you should rarely write more than a note or two.',
    'NEVER record private or sensitive data: real identity beyond a chosen display name, email / phone / address,',
    'employer-confidential specifics, secrets / tokens. When unsure whether something is private, do NOT record.',
    'Plan (todo): for any multi-step task, MAINTAIN a short plan via an optional "plan" array on your',
    'action: {"plan": [{"text": "<step>", "done": false}, ...]} (3-6 concise steps, in execution order).',
    'Each turn you may update it — mark finished steps done:true, REORDER by current priority, add/remove',
    'steps as the task evolves. When a NEW user message arrives mid-run, re-evaluate and REORDER the plan',
    'to fit the latest instruction before choosing the next action. Omit "plan" on turns where it is',
    'unchanged. Skip the plan entirely for a trivial single-step answer or plain conversation.',
    'Conversation & scope:',
    '- Natural conversation is fine: greet, say who you are, ask a clarifying question — answer directly',
    '  in "final" without calling tools.',
    '- Your domain is reviewing THIS PR (describing it, reviewing its changes, answering questions about',
    '  them). Politely DECLINE in "final" any task OUTSIDE that domain (unrelated coding, general/off-topic',
    '  requests) — do NOT call tools for it.',
    '- For a PR-related request with no clearly fitting tool, default to /ask with a focused question.',
  ].join('\n');
}

/** 规划单轮（plan-cycle 步骤）的运行上下文：依赖 + 输入 + 共享记录器 + 跨轮累加器。 */
interface PlanStepCtx {
  deps: PlanningDeps;
  input: PlanningInput;
  rec: StepRecorder;
  /** 完整 system（含 Protocol），逐轮复用。 */
  system: string;
  /** 既往多轮对话（按预算裁剪后的文本），逐轮复用。 */
  convo: string;
  labels: AgentStepLabels;
  /** 本轮 progress 累加（工具结果 / 红线拒绝回喂），逐轮追加。 */
  history: string[];
  /** 本轮主动记下、待持久化的非隐私条目，逐轮累加。 */
  memories: AgentMemoryNotes;
  /** 当前计划（todo），逐轮回喂提示；模型给出 plan 即更新（重排 / 勾选 / 增删）。 */
  plan: AgentTodoItem[];
}

/** plan-cycle 的产出：继续下一轮 / 收尾（带 final + 可选建议）/ 用户暂停。 */
type PlanCycleOutcome =
  | { kind: 'continue' }
  | { kind: 'final'; finalText: string; recommendation?: AgentRecommendation }
  | { kind: 'aborted' };

/**
 * 规划主循环的「单步」：拼当轮 prompt → chat → 解析动作 → 红线硬校验 → 并行派发工具 / 收尾。abort 在
 * 思考前后各检一次（思考阶段也能即时停）。规划是单步循环 —— 驱动重复调用本步直至 final / 步数上限。
 */
async function runPlanCycle(ctx: PlanStepCtx): Promise<PlanCycleOutcome> {
  const { deps, input, rec, system, convo, labels, history, memories } = ctx;
  if (deps.signal?.aborted) return { kind: 'aborted' };

  // 中途输入转向：把运行期间排队的用户新消息并入 progress，让本轮 ReAct 据「最新指令 + 当前进度」重排
  // 下一步。消息已由实现方在取出时持久化进会话，此处只注入提示、不再落盘。
  const pending = (await deps.drainPendingInput?.()) ?? [];
  for (const m of pending) {
    history.push(`New user message (latest instruction — reconcile with the plan and progress): ${m}`);
  }

  const user = [
    convo
      ? `Conversation so far (your context only — NEVER pass any of it to tools):\n${convo}\n`
      : '',
    `User request: ${input.userRequest}`,
    input.referencedContext
      ? `\nReferenced selection (your context only — NEVER pass any of it to tools):\n${input.referencedContext}`
      : '',
    ctx.plan.length
      ? `\nCurrent plan (keep it updated — mark items done, reorder by priority, add/remove as the task or new user messages change):\n${ctx.plan.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n')}`
      : '',
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
  if (deps.signal?.aborted) return { kind: 'aborted' };
  rec.track(r.usage);
  const action = extractJson<PlannerAction>(r.text);
  // 累加本动作携带的记忆（任何动作都可附 remember）。
  accumulateRemember(action?.remember, memories);
  // 计划更新：模型给出 plan 即归一、更新当前计划并持久化 + 广播（省略 plan = 沿用上一轮）。
  if (action?.plan !== undefined) {
    ctx.plan = normalizePlan(action.plan);
    await deps.recordPlan?.(ctx.plan);
  }

  const hasCalls = Boolean(action?.tool) || Boolean(action?.tools?.length);

  // 无法解析 / 既无 tool(s) 又无 final → 当作收尾。兜底从原始文本打捞散文，绝不把原始 JSON 动作丢给用户。
  if (!action || (!hasCalls && !action.final)) {
    const finalText = action?.final ?? salvageProse(r.text);
    await rec.record({ kind: 'plan', thought: action?.thought, result: finalText, thinkMs, usage: r.usage });
    return { kind: 'final', finalText };
  }

  if (action.final && !hasCalls) {
    // 剥掉模型误并入 final 末尾的判定 JSON（recommendation 走独立字段渲染为判定徽标）。
    const finalText = stripTrailingJson(action.final);
    await rec.record({ kind: 'plan', thought: action.thought, result: finalText, thinkMs, usage: r.usage });
    return { kind: 'final', finalText, recommendation: parseRecommendation(action.recommendation) };
  }

  // 归一为待执行工具列表：tools 多选（并行、只读）优先——元素可为工具名或 {tool, question}（多个
  // 带问题的 /ask 也能一轮并行派发）；否则单 tool（可带 question）。
  const requested: Array<{ tool: string; question?: string }> = action.tools?.length
    ? action.tools
        .slice(0, MAX_PARALLEL_TOOLS)
        .map((tl) => (typeof tl === 'string' ? { tool: tl } : { tool: tl.tool ?? '', question: tl.question }))
    : [{ tool: action.tool ?? '', question: action.question }];

  // 红线硬校验逐个把关：未授权 / 未知即拒并回喂；允许的留待并行执行。
  const allowed: Array<{ tool: string; question?: string }> = [];
  for (const c of requested) {
    try {
      assertToolAllowed(c.tool, input.toolCatalog);
      allowed.push(c);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await rec.record({
        kind: 'judge',
        thought: action.thought,
        toolCall: { tool: c.tool },
        result: `${labels.rejectedPrefix}${msg}`,
      });
      history.push(`Refused ${c.tool}: ${msg}`);
    }
  }
  if (!allowed.length) return { kind: 'continue' }; // 全被拒 → 回喂后下一轮重选

  // 类 Claude Code：先把本轮思考与所选步骤作为一步流式出去（思考是工具选择的前因），随后才执行工具。
  // 工具执行的进度 / 计时由 run 卡片承载，这里不再为每个工具补记 tool 步，避免决策被堆到结果之后。
  await rec.record({
    kind: 'plan',
    thought: action.thought,
    toolCall: { tool: allowed.map((c) => c.tool).join(' + ') },
    thinkMs,
    usage: r.usage,
  });

  // 并行分发允许的工具（多选时同时跑，实际并发受运行队列约束）；相互错开 100~200ms 起跑，避免同一瞬间齐发。
  const ran = await runStaggered(allowed, async (c) => ({ c, res: await deps.runTool(c) }));
  for (const { c, res } of ran) {
    rec.track(res.usage);
    history.push(`Called ${c.tool}${c.question ? ` ("${c.question}")` : ''} → ${clamp(res.text, 600)}`);
  }
  return { kind: 'continue' };
}

export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const rec = createStepRecorder(deps.onStep);
  const history: string[] = [];
  const memories = emptyMemoryNotes();
  const labels = stepLabels(input.language);

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRule: input.matchedRule,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${buildProtocol(summarySections(input.language))}`;

  // 既往多轮对话注入规划上下文（按预算裁剪），让 Agent 跨轮记住交流；仅供规划 LLM 参考，
  // 绝不透传给 pr-agent 工具。
  const convo = buildConversationContext(input.history ?? []);
  const ctx: PlanStepCtx = { deps, input, rec, system, convo, labels, history, memories, plan: [] };

  // 规划是单步循环：重复跑 plan-cycle 直至收尾 / 暂停 / 步数上限。
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await runPlanCycle(ctx);
    if (outcome.kind === 'aborted') {
      return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: '用户暂停' };
    }
    if (outcome.kind === 'final') {
      return {
        steps: rec.steps,
        finalText: outcome.finalText,
        tokenUsage: rec.usage,
        recommendation: outcome.recommendation,
        memories,
      };
    }
  }

  return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: '步数上限中止' };
}
