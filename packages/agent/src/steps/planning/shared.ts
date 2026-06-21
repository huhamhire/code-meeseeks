import type {
  AgentMessage,
  AgentRecommendation,
  AgentRecommendationVerdict,
  AgentTodoItem,
} from '@meebox/shared';
import type { MemoryNote } from '../../memory.js';
import type { AgentStepLabels } from '../../orchestrator.js';
import type { AgentMemoryNotes, PlanningDeps, PlanningInput } from '../../planner.js';
import { PROMPT_TEMPLATES, fillTemplate } from '../../prompts.js';
import type { StepRecorder } from '../context.js';

/**
 * 自由规划 plan-cycle 步骤的共享件：动作类型 + 解析（记忆 / 建议 / 计划）、会话上下文与协议拼装、运行上下文。
 * 步骤本体见 ./plan-cycle-step，驱动见 ../../planner。
 */

export interface PlannerAction {
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

/** 解析单条记忆：必须是带 `section` + `note` 的对象；无法归入专题章节的条目丢弃（返回 null）。 */
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
export function accumulateRemember(value: PlannerAction['remember'], acc: AgentMemoryNotes): void {
  if (!value || typeof value !== 'object') return;
  acc.user.push(...toNoteList(value.user));
  acc.memory.push(...toNoteList(value.memory));
  acc.agents.push(...toNoteList(value.agents));
}

const VERDICTS: readonly AgentRecommendationVerdict[] = ['approve', 'needs_work', 'manual_review'];

/** 从收尾动作解析出合法 recommendation；verdict 非法 / 缺省 → undefined（不强加判定）。 */
export function parseRecommendation(
  rec?: PlannerAction['recommendation'],
): AgentRecommendation | undefined {
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
export function normalizePlan(raw: PlannerAction['plan']): AgentTodoItem[] {
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

export function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** 一次并行最多分发的工具数：多选时截断，防止一轮打出过多 pr-agent run。 */
export const MAX_PARALLEL_TOOLS = 3;

/**
 * 注入规划上下文的历史对话预算：单条字符上限 + 总字符预算（从最新往回累计、超预算即裁剪更早的）。
 * 约定会话上下文不超过 LLM 上下文窗口的一半——以字符近似 token 做保守封顶：64k 字符 ≈ 16~40k token。
 */
const HISTORY_MESSAGE_MAX = 2000;
const HISTORY_BUDGET_CHARS = 64000;

/** 取最近若干轮、各自限长，并按总预算从新到旧裁剪（丢弃超预算的更早消息），返回时间升序文本。 */
export function buildConversationContext(history: readonly AgentMessage[]): string {
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

/** 规划 ReAct 协议：正文外置在 resources/prompts/protocol.md，三段标题（按语言本地化）经占位符注入。 */
export function buildProtocol(sections: readonly [string, string, string]): string {
  const [overview, findings, suggestions] = sections;
  return fillTemplate(PROMPT_TEMPLATES.protocol, { overview, findings, suggestions });
}

/** 规划单轮（plan-cycle 步骤）的运行上下文：依赖 + 输入 + 共享记录器 + 跨轮累加器。 */
export interface PlanStepCtx {
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
export type PlanCycleOutcome =
  | { kind: 'continue' }
  | { kind: 'final'; finalText: string; recommendation?: AgentRecommendation }
  | { kind: 'aborted' };
