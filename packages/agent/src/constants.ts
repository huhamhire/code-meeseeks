import type { AgentRecommendationVerdict } from '@meebox/shared';
import type { AgentContextFiles } from './types.js';

/**
 * 包内常量统一收口：所有值常量（标量 / 字符串 / 纯数据数组与映射）集中于此，便于复用与调参。
 * 不收的两类（非「值常量」）：step 注册表（steps/review/index.ts 的 REVIEW_STEP_REGISTRY，实例化各 step 类的组合根）、
 * ?raw 资源载入对象（prompts.ts 的 PROMPT_TEMPLATES、templates.ts 的 AGENT_TEMPLATES）——它们是各自模块的本体。
 */

// ── 评审判定 ──
/** 评审判定的合法取值：规划收尾（steps/planning）与评审微流程（steps/review）解析建议时共用的白名单。 */
export const VERDICTS: readonly AgentRecommendationVerdict[] = [
  'approve',
  'needs_work',
  'manual_review',
];

// ── Agent 目录布局 ──
/**
 * Agent 目录的固定文件布局（见 docs/arch/06-agent.md「Agent 目录」）。
 * - SOUL.md  灵魂：核心职责与边界（Agent 只读，默认由模版规定）
 * - AGENTS.md 工作规范与红线
 * - MEMORY.md 长期记忆（可写）
 * - USER.md  用户画像（可写）
 */
export const AGENT_FILES = {
  soul: 'SOUL.md',
  agents: 'AGENTS.md',
  memory: 'MEMORY.md',
  user: 'USER.md',
} as const;

/** rules/ 子目录名：规则正文存放处，匹配语义见 @meebox/rules（docs/arch/07-rules.md）。 */
export const AGENT_RULES_SUBDIR = 'rules';

/** 全空上下文文件集：空 agentDir / 读失败时的失败安全回退（Agent 退化为原生）。 */
export const EMPTY_FILES: AgentContextFiles = { soul: '', agents: '', memory: '', user: '' };

// 工具清单（读 / 改 / grant）已收口到 @meebox/shared 的统一注册表 tool-registry（TOOLS）；
// 工具目录由 buildToolCatalog 从中派生，见 tool-catalog.ts。

// ── 工具并发错开（见 stagger.ts）──
/**
 * 把并发分发的工具调用相互错开一个累计的随机延迟：首个立即发出，其余各在前一个基础上再加
 * [MIN, MIN+SPAN]ms 起跑，避免不同工具在同一瞬间齐发、抢占子进程 spawn / LLM 网络。
 * 实际单步延迟 ∈ [100, 200]ms。
 */
export const STAGGER_MIN_MS = 100;
export const STAGGER_SPAN_MS = 100;

// ── 规划（ReAct）──
/** 一次并行最多分发的工具数：多选时截断，防止一轮打出过多 pr-agent run。 */
export const MAX_PARALLEL_TOOLS = 3;

/**
 * 注入规划上下文的历史对话预算：单条字符上限 + 总字符预算（从最新往回累计、超预算即裁剪更早的）。
 * 约定会话上下文不超过 LLM 上下文窗口的一半——以字符近似 token 做保守封顶：64k 字符 ≈ 16~40k token。
 */
export const HISTORY_MESSAGE_MAX = 2000;
export const HISTORY_BUDGET_CHARS = 64000;

// ── 追问判读（steps/review）──
/** 追问判断用的精简系统提示：不带 agent 完整上下文（SOUL / 记忆 / 用户档 / 工具目录 / 规则 / PR 元数据）。
 *  这是一次轻量路由判读，仅凭 describe + review 结果判「是否有严重问题需追问」，与 AutoPilot 初判同思路。 */
export const JUDGE_SYSTEM =
  'You are a senior code reviewer triaging review findings for follow-up. Be decisive and terse; reply with JSON only, no reasoning.';

/** 追问判读的输出 token 上限：产物是极小 JSON（severe + 至多数条问题），无需大额度。 */
export const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** 收尾总结的输出 token 上限：总结是整段 markdown 综合（三段 + 末尾判定 JSON），给足额度避免被 provider
 *  默认上限截断（截断会连带丢掉末尾判定 → 回落 manual_review）。summaryMax 是软字符指引，这里是硬封顶。 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 4096;

// ── AutoPilot 准入判读（autopilot-judge.ts）──
/** 候选 PR 描述喂判读 LLM 前的截断字符数：控制 prompt 体积，准入判读不需要完整描述。 */
export const DESC_CLAMP = 600;

// ── 系统上下文装配（assemble.ts）──
/**
 * 缓存断点标记：插在「全局稳定前缀」与「PR/运行相关尾部」之间（含两侧 --- 分隔）。嵌入式 shim 据此把
 * 稳定前缀单独标 Anthropic 提示缓存（1h）、跨 PR/运行命中，尾部保持纯文本；消费端分割 / 剥除后标记绝不
 * 进入发给模型的 prompt（litellm 分块、CLI 拼接均处理）。
 * **须与 scripts/pragent-shim/meebox_pragent_shim/runtime.py 的 `CACHE_BREAK` 逐字一致。**
 */
export const CACHE_BREAK = '\n\n---\n\n[[MEEBOX:CACHE_BREAK]]\n\n---\n\n';
