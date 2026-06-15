import type {
  AgentConversationFile,
  AgentMessage,
  AgentSession,
  AgentSessionFile,
  AgentSessionStatus,
  AgentStep,
  AgentTodoItem,
  AgentTranscriptFile,
  AgentRecommendation,
} from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import { makeRunId } from './runs.js';

/**
 * Agent 会话落在 `prs/<localId>/agent/`：每个 PR 一份 session + 一条 transcript，
 * 与 meta / comments / runs 同处该 PR 目录，PR 退场时 deleteDir 整棵清掉（与它们同寿命）。
 * localId 是 prHashId 出来的 12 位 hex，无路径不安全字符，不需 sanitize。
 */
function sessionKey(prLocalId: string): string {
  return `prs/${prLocalId}/agent/session`;
}
function transcriptKey(prLocalId: string): string {
  return `prs/${prLocalId}/agent/transcript`;
}
function conversationKey(prLocalId: string): string {
  return `prs/${prLocalId}/agent/conversation`;
}

export interface StartAgentSessionInput {
  prLocalId: string;
  maxSteps: number;
  /** 外部预分配的 session id（与队列 id 对齐）；缺省按时序生成。 */
  id?: string;
  /** 触发会话的用户自然语言请求（agent:ask）；自动评审无文本则缺省。 */
  userRequest?: string;
}

/**
 * 起一个新会话：写初始 running 状态，并把 transcript 清空（新会话覆盖旧的，
 * 每个 PR 同时只有一份当前会话，见「会话隔离」）。
 */
export async function startAgentSession(
  stateStore: StateStore,
  input: StartAgentSessionInput,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  const at = now();
  const session: AgentSession = {
    id: input.id ?? makeRunId(at),
    prLocalId: input.prLocalId,
    status: 'running',
    todo: [],
    stepCount: 0,
    maxSteps: input.maxSteps,
    ...(input.userRequest ? { userRequest: input.userRequest } : {}),
    startedAt: at.toISOString(),
  };
  await stateStore.write<AgentSessionFile>(sessionKey(input.prLocalId), {
    schema_version: 1,
    session,
  });
  await stateStore.write<AgentTranscriptFile>(transcriptKey(input.prLocalId), {
    schema_version: 1,
    steps: [],
  });
  return session;
}

export interface AgentSessionPatch {
  status?: AgentSessionStatus;
  todo?: AgentTodoItem[];
  stepCount?: number;
  summary?: string;
  recommendation?: AgentRecommendation;
  finishedAt?: string;
  terminationReason?: string;
}

/**
 * Merge patch 到已存在的会话并重写。会话不存在返回 null（不重建空记录，避免
 * start 失败后的 update 静默成功；与 finishReviewRun 一致）。
 */
export async function updateAgentSession(
  stateStore: StateStore,
  prLocalId: string,
  patch: AgentSessionPatch,
): Promise<AgentSession | null> {
  const file = await stateStore.read<AgentSessionFile>(sessionKey(prLocalId));
  if (!file) return null;
  const next: AgentSession = { ...file.session, ...patch };
  await stateStore.write<AgentSessionFile>(sessionKey(prLocalId), {
    schema_version: 1,
    session: next,
  });
  return next;
}

export async function getAgentSession(
  stateStore: StateStore,
  prLocalId: string,
): Promise<AgentSession | null> {
  const file = await stateStore.read<AgentSessionFile>(sessionKey(prLocalId));
  return file?.session ?? null;
}

export async function getAgentTranscript(
  stateStore: StateStore,
  prLocalId: string,
): Promise<AgentStep[]> {
  const file = await stateStore.read<AgentTranscriptFile>(transcriptKey(prLocalId));
  return file?.steps ?? [];
}

/**
 * 追加一个编排步骤到 transcript，并同步会话的 stepCount（= transcript 长度）。
 * 会话不存在返回 null（必须先 start）。`at` 缺省时打当前时间。
 */
export async function appendAgentStep(
  stateStore: StateStore,
  prLocalId: string,
  step: AgentStep,
  now: () => Date = () => new Date(),
): Promise<AgentSession | null> {
  const sessionFile = await stateStore.read<AgentSessionFile>(sessionKey(prLocalId));
  if (!sessionFile) return null;

  const steps = await getAgentTranscript(stateStore, prLocalId);
  steps.push({ ...step, at: step.at ?? now().toISOString() });
  await stateStore.write<AgentTranscriptFile>(transcriptKey(prLocalId), {
    schema_version: 1,
    steps,
  });

  const next: AgentSession = { ...sessionFile.session, stepCount: steps.length };
  await stateStore.write<AgentSessionFile>(sessionKey(prLocalId), {
    schema_version: 1,
    session: next,
  });
  return next;
}

/** 清掉某 PR 的会话 + transcript + 多轮对话（删 `prs/<localId>/agent/*`）。 */
export async function clearAgentSession(
  stateStore: StateStore,
  prLocalId: string,
): Promise<void> {
  await stateStore.delete(sessionKey(prLocalId));
  await stateStore.delete(transcriptKey(prLocalId));
  await stateStore.delete(conversationKey(prLocalId));
}

/**
 * 多轮对话日志（跨回合保留，独立于 per-turn 的 session / transcript 生命周期）：读取本 PR
 * 全部消息（用户输入 + Agent 收尾回答）。无则空数组。
 */
export async function getAgentConversation(
  stateStore: StateStore,
  prLocalId: string,
): Promise<AgentMessage[]> {
  const file = await stateStore.read<AgentConversationFile>(conversationKey(prLocalId));
  return file?.messages ?? [];
}

/** 追加一条对话消息（用户 / 助手），返回追加后的完整消息列表。`at` 缺省打当前时间。 */
export async function appendAgentMessage(
  stateStore: StateStore,
  prLocalId: string,
  message: Omit<AgentMessage, 'at'> & { at?: string },
  now: () => Date = () => new Date(),
): Promise<AgentMessage[]> {
  const messages = await getAgentConversation(stateStore, prLocalId);
  messages.push({ ...message, at: message.at ?? now().toISOString() });
  await stateStore.write<AgentConversationFile>(conversationKey(prLocalId), {
    schema_version: 1,
    messages,
  });
  return messages;
}
