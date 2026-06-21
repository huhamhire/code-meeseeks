import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AgentMessage, AgentStep, AgentTodoItem, ReviewRun } from '@meebox/shared';
import { invoke, subscribe } from '../../../../api';
import { RUNS_PAGE_SIZE } from '../constants';
import type { MatchedRule } from '../types';

export interface ChatSession {
  runs: ReviewRun[];
  setRuns: React.Dispatch<React.SetStateAction<ReviewRun[]>>;
  hasMoreOlder: boolean;
  setHasMoreOlder: React.Dispatch<React.SetStateAction<boolean>>;
  loadingOlder: boolean;
  loadingSession: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  matchedRule: MatchedRule;
  agentSteps: AgentStep[];
  setAgentSteps: React.Dispatch<React.SetStateAction<AgentStep[]>>;
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  /** 规划 Agent 的计划（todo）：随 agent:planUpdated 实时刷新，切 PR 经 getSession 水合。 */
  todo: AgentTodoItem[];
  setTodo: React.Dispatch<React.SetStateAction<AgentTodoItem[]>>;
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  /** 当前展示中的 PR id（每渲染同步）：异步任务 resolve 时据此判断是否仍停在发起 PR。 */
  currentPrIdRef: MutableRefObject<string | undefined>;
  /** 从 main 重载某 PR 的多轮对话（落盘版为准）；仅当仍停在该 PR 才落到当前视图。 */
  reloadConversation: (localId: string) => Promise<void>;
}

/**
 * ChatPane 的会话态与生命周期：切 PR 时重载 run 历史 / 规则 / 多轮对话 / 过程步骤，
 * 订阅流式步骤与对话变更，跑完的 run 逐条插入，向上滚动游标分页，新内容自动滚到底。
 *
 * 入参 `myActiveIds` 是本 PR 运行中 run 的 runId 列表（来源于全局 store），用于：
 * 检测「某条跑完了」→ 单独 fetch 插入；以及新 run / 活动集变化时滚到底。
 */
export function useChatSession(
  prLocalId: string | undefined,
  myActiveIds: string[],
): ChatSession {
  // runs 按 startedAt 升序保存 (chat 习惯：旧在上 / 新在下)。分页：进入 PR 默认拉
  // 最新 RUNS_PAGE_SIZE 条，向上滚到顶端用 runs[0].id 当游标向 main 要更早一批
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 切 PR 时初次拉取（runs / 规则 / 会话 / transcript）在飞标志：期间盖延迟 loading，
  // 避免「清空 → 空白 → 内容 pop-in」的抖动。延迟显示让快路径（缓存命中）零闪烁。
  const [loadingSession, setLoadingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 当前 PR 命中的规则 (针对 /review 工具；缺省 tools=[review] 是规则最常生效的场景)
  const [matchedRule, setMatchedRule] = useState<MatchedRule>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  // 多轮对话消息（用户输入 + Agent 回答），跨回合保留、由 main 落盘 conversation.json，
  // 切回该 PR 恢复。用户消息含临时 optimistic 项（提交即回显），收尾后整体以落盘版重载对齐。
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  // 规划 Agent 的计划（todo）：随 agent:planUpdated 实时刷新；切 PR 经 agent:getSession 水合。
  const [todo, setTodo] = useState<AgentTodoItem[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 当前展示中的 PR id（每渲染同步）：异步 Agent 任务 resolve 时据此判断是否仍停在发起 PR，
  // 避免把收尾结果 / 错误串台到切换后打开的别的 PR 会话。
  const currentPrIdRef = useRef<string | undefined>(undefined);
  currentPrIdRef.current = prLocalId;

  // PR 切换：重置面板状态 + 拉该 PR 的 run 历史 (含切走前还在跑、现在已落盘的 run)。
  // 依赖用 pr?.localId 而不是 pr 对象引用：App 在 poll tick / window focus 时会
  // reloadPrs → 新 prs 数组 → selected 是新对象引用；localId 是稳定字符串，同 PR 刷新不触发。
  useEffect(() => {
    setRuns([]);
    setHasMoreOlder(false);
    setLoadingOlder(false);
    setError(null);
    setMatchedRule(null);
    setAgentSteps([]);
    setMessages([]);
    setTodo([]);
    setLoadingSession(false);
    if (!prLocalId) return;
    let cancelled = false;
    setLoadingSession(true);
    void (async () => {
      try {
        // listRuns 默认返回 newest-first；这里只拉最新一页 (RUNS_PAGE_SIZE)。
        // 同时拉已落盘的多轮对话 + 过程步骤（transcript）：把会话恢复到其 PR，跨切换 / 重启不丢失，
        // 过程化跟踪的思考步骤也随之恢复（步骤随产生增量落盘）。
        const [list, rule, conversation, transcript, session] = await Promise.all([
          invoke('pragent:listRuns', { localId: prLocalId, limit: RUNS_PAGE_SIZE }),
          invoke('rules:matchForPr', { localId: prLocalId, tool: 'review' }),
          invoke('agent:getConversation', { localId: prLocalId }),
          invoke('agent:getTranscript', { localId: prLocalId }),
          invoke('agent:getSession', { localId: prLocalId }),
        ]);
        if (cancelled) return;
        // 反转为升序 (chat 习惯)，UI 直接读 runs 即可
        setRuns([...list].reverse());
        setHasMoreOlder(list.length === RUNS_PAGE_SIZE);
        setMatchedRule(rule);
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

  // Agent 步骤流式：订阅 main 的 agent:stepProgress，按当前 PR 过滤实时追加。
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:stepProgress', (ev) => {
      // 流式步骤可能未带 at（编排器广播在落盘 stamp 之前）→ 到达即补一个时间戳，
      // 供下方与 run 卡片按时间归并排序（自然时间顺序展示）。
      if (ev.prLocalId === prLocalId)
        setAgentSteps((s) => [...s, { ...ev.step, at: ev.step.at ?? new Date().toISOString() }]);
    });
  }, [prLocalId]);

  // 从 main 重载某 PR 的多轮对话（落盘版为准）；仅当仍停在该 PR 才落到当前视图，避免串台。
  const reloadConversation = async (localId: string): Promise<void> => {
    try {
      const conversation = await invoke('agent:getConversation', { localId });
      if (currentPrIdRef.current === localId) setMessages(conversation);
    } catch {
      /* 忽略：下次 PR 切换 effect 会重载 */
    }
  };

  // 后台评审（AutoPilot）收尾追加「评审总结」消息时，若正打开该 PR 则重载会话，让总结卡片即时出现。
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:conversationChanged', (ev) => {
      if (ev.prLocalId === prLocalId) void reloadConversation(prLocalId);
    });
  }, [prLocalId]);

  // 计划（todo）实时刷新：规划 Agent 每轮给出 / 更新 plan 即广播，按当前 PR 过滤更新计划面板。
  useEffect(() => {
    if (!prLocalId) return;
    return subscribe('agent:planUpdated', (ev) => {
      if (ev.prLocalId === prLocalId) setTodo(ev.todo);
    });
  }, [prLocalId]);

  // 本 PR 的运行中 run 集合发生「移除」→ 那条跑完了：单独 fetch 它 + 按 runId 升序
  // 插入 runs（不重拉整页，避免毁掉用户已向上加载的更早历史）。lines 缓存的回收已
  // 上移到 store 层（setQueue 全局处理），这里不再负责。多并发下逐条 diff 处理。
  const myActiveIdsKey = myActiveIds.join(',');
  const prevMyActiveRef = useRef<string[]>(myActiveIds);
  const prevPrRef = useRef<string | undefined>(prLocalId);
  useEffect(() => {
    const prevPr = prevPrRef.current;
    prevPrRef.current = prLocalId;
    const prev = prevMyActiveRef.current;
    prevMyActiveRef.current = myActiveIds;
    // PR 切换：prev 属于旧 PR，不能当本 PR 的「跑完」处理，仅同步 ref
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
                // 已在列表（重复事件 / 重连）→ 就地更新
                const next = prevRuns.slice();
                next[idx] = finished;
                return next;
              }
              // 并发完成顺序 ≠ runId 顺序：按 runId 升序插入而非无条件 append，
              // 维持 runs 始终有序（loadOlderRuns 以 runs[0].id 作游标拉更早历史，
              // 依赖此不变量）。runId 字典序即时序，可直接字符串比较。
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

  // 向上滚到顶端 → 用 runs[0].id 当游标，向 main 要更早一批，prepend 到 runs。
  // 保留视觉滚动位置：插入新内容后把 scrollTop 推到 (newHeight - prevHeight)
  // 抵消，用户看上去像"接着原来位置"
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
      // older 是 newest-first，反转后整段塞到 runs 前面
      setRuns((prev) => [...[...older].reverse(), ...prev]);
      setHasMoreOlder(older.length === RUNS_PAGE_SIZE);
      // 下一帧补齐滚动位置
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

  // 新 run 完成 / 运行中 run 集合变化时自动滚到底，让最新消息浮上来
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, myActiveIdsKey]);

  // 向上滚到顶端 → 触发 loadOlderRuns 拉更早一批 (cursor = runs[0].id)
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (el.scrollTop > 8) return;
      void loadOlderRuns();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
    // loadOlderRuns 是稳定的语义包装，依赖项放足够即可
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
    matchedRule,
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
