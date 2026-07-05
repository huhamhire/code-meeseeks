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
 * Agent sessions live under `prs/<localId>/agent/`: one session + one transcript per PR,
 * alongside meta / comments / runs in that PR directory; on PR retirement deleteDir wipes the whole tree (same lifespan as them).
 * localId is the 12-hex output of prHashId, has no path-unsafe characters, and needs no sanitize.
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
  /** Externally pre-allocated session id (aligned with the queue id); defaults to time-ordered generation. */
  id?: string;
  /** The user's natural-language request that triggered the session (agent:ask); defaults absent for auto reviews with no text. */
  userRequest?: string;
}

/**
 * Start a new session: write the initial running status and clear the transcript (a new session overwrites the old one,
 * each PR has only one current session at a time, see "session isolation").
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
 * Merge the patch into an existing session and rewrite it. Returns null if the session does not exist (does not rebuild an empty record, to avoid
 * an update silently succeeding after a failed start; consistent with finishReviewRun).
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
 * Append an orchestration step to the transcript and sync the session's stepCount (= transcript length).
 * Returns null if the session does not exist (must start first). `at` defaults to the current time.
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

/** Wipe a PR's session + transcript + multi-turn conversation (delete `prs/<localId>/agent/*`). */
export async function clearAgentSession(
  stateStore: StateStore,
  prLocalId: string,
): Promise<void> {
  await stateStore.delete(sessionKey(prLocalId));
  await stateStore.delete(transcriptKey(prLocalId));
  await stateStore.delete(conversationKey(prLocalId));
}

/**
 * Multi-turn conversation log (retained across turns, independent of the per-turn session / transcript lifecycle): read this PR's
 * full message list (user input + Agent's summary answers). Empty array if none.
 */
export async function getAgentConversation(
  stateStore: StateStore,
  prLocalId: string,
): Promise<AgentMessage[]> {
  const file = await stateStore.read<AgentConversationFile>(conversationKey(prLocalId));
  return file?.messages ?? [];
}

/** Rewrite a PR's multi-turn conversation as a whole (used to compact / replace old messages with a summary). */
export async function writeAgentConversation(
  stateStore: StateStore,
  prLocalId: string,
  messages: AgentMessage[],
): Promise<void> {
  await stateStore.write<AgentConversationFile>(conversationKey(prLocalId), {
    schema_version: 1,
    messages,
  });
}

/** Append a conversation message (user / assistant), returning the full message list after the append. `at` defaults to the current time. */
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
