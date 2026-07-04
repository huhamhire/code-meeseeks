import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AgentMessage, AgentStep, AgentTodoItem, ReviewRun } from '@meebox/shared';
import { invoke, subscribe } from '../../../../api';
import { RUNS_PAGE_SIZE } from '../constants';
import type { MatchedRules } from '../types';

export interface ChatSession {
  runs: ReviewRun[];
  setRuns: React.Dispatch<React.SetStateAction<ReviewRun[]>>;
  hasMoreOlder: boolean;
  setHasMoreOlder: React.Dispatch<React.SetStateAction<boolean>>;
  loadingOlder: boolean;
  loadingSession: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  matchedRules: MatchedRules;
  agentSteps: AgentStep[];
  setAgentSteps: React.Dispatch<React.SetStateAction<AgentStep[]>>;
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  /** The planning Agent's plan (todo): refreshed in real time with agent:planUpdated, hydrated via getSession on PR switch. */
  todo: AgentTodoItem[];
  setTodo: React.Dispatch<React.SetStateAction<AgentTodoItem[]>>;
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  /** The PR id currently displayed (synced every render): used when an async task resolves to decide whether we're still on the initiating PR. */
  currentPrIdRef: MutableRefObject<string | undefined>;
  /** Reload a PR's multi-turn conversation from main (persisted version is authoritative); only applied to the current view if still on that PR. */
  reloadConversation: (localId: string) => Promise<void>;
}

/**
 * ChatPane's session state and lifecycle: on PR switch, reload run history / rules / multi-turn conversation / process steps,
 * subscribe to streaming steps and conversation changes, insert finished runs one by one, cursor-paginate on scroll up, auto-scroll to bottom on new content.
 *
 * The `myActiveIds` param is the list of runIds of runs in progress for this PR (sourced from the global store), used for:
 * detecting "one finished" → fetch and insert it individually; and scrolling to bottom when a new run / the active set changes.
 */
export function useChatSession(
  prLocalId: string | undefined,
  myActiveIds: string[],
): ChatSession {
  // runs kept in ascending startedAt order (chat convention: old on top / new at bottom). Pagination: entering a PR pulls
  // the latest RUNS_PAGE_SIZE by default; scrolling up to the top uses runs[0].id as the cursor to request an earlier batch from main
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // In-flight flag for the initial fetch on PR switch (runs / rules / session / transcript): during it, cover with delayed loading
  // to avoid the "clear → blank → content pop-in" jitter. Delayed display gives the fast path (cache hit) zero flicker.
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // All rules matched for the current PR (for the /review tool; default tools=[review] is the scenario where rules most often apply)
  const [matchedRules, setMatchedRules] = useState<MatchedRules>([]);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  // Multi-turn conversation messages (user input + Agent replies), kept across turns, persisted by main to conversation.json,
  // restored when switching back to that PR. User messages include temporary optimistic items (echoed on submit), aligned wholesale against the persisted version on reload after completion.
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  // The planning Agent's plan (todo): refreshed in real time with agent:planUpdated; hydrated via agent:getSession on PR switch.
  const [todo, setTodo] = useState<AgentTodoItem[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The PR id currently displayed (synced every render): used when an async Agent task resolves to decide whether we're still on the initiating PR,
  // to avoid crossing the conclusion result / error into a different PR session opened after switching.
  const currentPrIdRef = useRef<string | undefined>(undefined);
  currentPrIdRef.current = prLocalId;

  // PR switch: reset panel state + pull this PR's run history (including runs still running before the switch, now persisted).
  // Depend on pr?.localId rather than the pr object reference: App does reloadPrs on poll tick / window focus
  // → new prs array → selected is a new object reference; localId is a stable string, so refreshing the same PR does not trigger.
  useEffect(() => {
    setRuns([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setError(null);
    setMatchedRules([]);
    setAgentSteps([]);
    setMessages([]);
    setTodo([]);
    setLoadingSession(false);
    if (!prLocalId) return;
    let cancelled = false;
    setLoadingSession(true);
    void (async () => {
      try {
        // listRuns returns newest-first by default; here we only pull the latest page (RUNS_PAGE_SIZE).
        // Also pull the persisted multi-turn conversation + process steps (transcript): restore the session to its PR, not lost across switch / restart,
        // and the process-tracked thinking steps are restored along with it (steps are persisted incrementally as produced).
        const [list, rules, conversation, transcript, session] = await Promise.all([
          invoke('pragent:listRuns', { localId: prLocalId, limit: RUNS_PAGE_SIZE }),
          invoke('rules:matchForPr', { localId: prLocalId, tool: 'review' }),
          invoke('agent:getConversation', { localId: prLocalId }),
          invoke('agent:getTranscript', { localId: prLocalId }),
          invoke('agent:getSession', { localId: prLocalId }),
        ]);
        if (cancelled) return;
        // Reverse to ascending order (chat convention); the UI can read runs directly
        setRuns([...list].reverse());
        setHasMoreOlder(list.length === RUNS_PAGE_SIZE);
        setMatchedRules(rules);
        setMessages(conversation);
        setAgentSteps(transcript);
        setTodo(session?.todo ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prLocalId]);

  // Agent step streaming: subscribe to main's agent:stepProgress, filter by current PR and append in real time.
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:stepProgress', (ev) => {
      // Streaming steps may arrive without at (the orchestrator broadcasts before the persist stamp) → stamp one on arrival,
      // so the section below can merge-sort by time with run cards (displayed in natural time order).
      if (ev.prLocalId === prLocalId)
        setAgentSteps((s) => [...s, { ...ev.step, at: ev.step.at ?? new Date().toISOString() }]);
    });
  }, [prLocalId]);

  // Reload a PR's multi-turn conversation from main (persisted version is authoritative); only applied to the current view if still on that PR, to avoid crossing.
  const reloadConversation = async (localId: string): Promise<void> => {
    try {
      const conversation = await invoke('agent:getConversation', { localId });
      if (currentPrIdRef.current === localId) setMessages(conversation);
    } catch {
      /* Ignore: the next PR-switch effect will reload */
    }
  };

  // When background review (AutoPilot) appends a "review summary" message on conclusion, reload the session if that PR is open, so the summary card appears immediately.
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:conversationChanged', (ev) => {
      if (ev.prLocalId === prLocalId) void reloadConversation(prLocalId);
    });
  }, [prLocalId]);

  // Plan (todo) real-time refresh: the planning Agent broadcasts each round when it gives / updates the plan; filter by current PR and update the plan panel.
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:planUpdated', (ev) => {
      if (ev.prLocalId === prLocalId) setTodo(ev.todo);
    });
  }, [prLocalId]);

  // When this PR's set of in-progress runs sees a "removal" → that one finished: fetch it individually + insert into runs
  // in ascending runId order (don't refetch the whole page, to avoid destroying the earlier history the user loaded upward). Reclaiming the lines cache has
  // moved up to the store layer (handled globally by setQueue) and is no longer done here. Diff processed one by one under concurrency.
  const myActiveIdsKey = myActiveIds.join(',');
  const prevMyActiveRef = useRef<string[]>(myActiveIds);
  const prevPrRef = useRef<string | undefined>(prLocalId);
  useEffect(() => {
    const prevPr = prevPrRef.current;
    prevPrRef.current = prLocalId;
    const prev = prevMyActiveRef.current;
    prevMyActiveRef.current = myActiveIds;
    // PR switch: prev belongs to the old PR, so it must not be treated as this PR's "finished"; only sync the ref
    if (prevPr !== prLocalId || !prLocalId) return;
    const current = new Set(myActiveIds);
    for (const runId of prev) {
      if (current.has(runId)) continue;
      void (async () => {
        try {
          const finished = await invoke('pragent:getRun', { localId: prLocalId, runId });
          if (finished) {
            setRuns((prevRuns) => {
              const idx = prevRuns.findIndex((r) => r.id === finished.id);
              if (idx >= 0) {
                // Already in the list (duplicate event / reconnect) → update in place
                const next = prevRuns.slice();
                next[idx] = finished;
                return next;
              }
              // Concurrent completion order ≠ runId order: insert in ascending runId order rather than unconditional append,
              // keeping runs always ordered (loadOlderRuns uses runs[0].id as the cursor to pull earlier history,
              // relying on this invariant). runId lexical order is the time order, so a direct string comparison works.
              const insertAt = prevRuns.findIndex((r) => r.id > finished.id);
              if (insertAt < 0) return [...prevRuns, finished];
              const next = prevRuns.slice();
              next.splice(insertAt, 0, finished);
              return next;
            });
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myActiveIdsKey, prLocalId]);

  // Scroll up to the top → use runs[0].id as the cursor, request an earlier batch from main, prepend to runs.
  // Preserve the visual scroll position: after inserting new content, push scrollTop by (newHeight - prevHeight)
  // to offset, so it looks to the user like "continuing from the original position"
  const loadOlderRuns = async (): Promise<void> => {
    if (loadingOlder || !hasMoreOlder || !prLocalId || runs.length === 0) return;
    setLoadingOlder(true);
    const el = bodyRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const older = await invoke('pragent:listRuns', {
        localId: prLocalId,
        limit: RUNS_PAGE_SIZE,
        beforeId: runs[0]!.id,
      });
      // older is newest-first; reverse and stuff the whole batch in front of runs
      setRuns((prev) => [...[...older].reverse(), ...prev]);
      setHasMoreOlder(older.length === RUNS_PAGE_SIZE);
      // Restore the scroll position on the next frame
      requestAnimationFrame(() => {
        if (!bodyRef.current) return;
        bodyRef.current.scrollTop = prevTop + (bodyRef.current.scrollHeight - prevHeight);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-scroll to bottom when a new run completes / the set of in-progress runs changes, so the latest message surfaces
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, myActiveIdsKey]);

  // Scroll up to the top → trigger loadOlderRuns to pull an earlier batch (cursor = runs[0].id)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (el.scrollTop > 8) return;
      void loadOlderRuns();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
    // loadOlderRuns is a stable semantic wrapper; listing enough deps is sufficient
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMoreOlder, loadingOlder, prLocalId, runs.length]);

  return {
    runs,
    setRuns,
    hasMoreOlder,
    setHasMoreOlder,
    loadingOlder,
    loadingSession,
    error,
    setError,
    matchedRules,
    agentSteps,
    setAgentSteps,
    messages,
    setMessages,
    todo,
    setTodo,
    bodyRef,
    currentPrIdRef,
    reloadConversation,
  };
}
