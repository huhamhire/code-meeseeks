import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PrDiscoveryFilter, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from '../api';
import { formatBackendError } from '../errors';

/**
 * 跨组件跳转意图（M4）：ChatPane finding card 点「编辑」/ PublishReviewModal anchor 点击 / 通知点击 inline
 * 评论 → 这里 set → PrPanel 切到 Diff tab + 透传给 DiffView 做 scroll/highlight/(可选)open edit zone，消费完清空。
 */
export interface PendingDiffNav {
  runId?: string;
  findingId?: string;
  anchor: { path: string; startLine: number; endLine: number };
}

export interface PrNavigation {
  /** 列表范围：进行中（活跃）/ 已关闭（归档冷存储，懒加载、只读）。 */
  scope: 'active' | 'archived';
  /** GitHub 发现分类（运行时筛选，不持久化）；仅活动连接支持时在 PR 列表展示。 */
  discoveryFilter: PrDiscoveryFilter;
  /** 当前展示列表（归档范围用归档列表，其余用活跃列表）。 */
  displayedPrs: StoredPullRequest[];
  /** 当前展示列表里解析出的选中 PR（解析不到回 null）。 */
  selectedPr: StoredPullRequest | null;
  /** 归档冷存储拉取中（列表区据此显示 loading）。 */
  archivedLoading: boolean;
  /** 选发现分类（侧栏 tab / 命令面板）→ 回到「进行中」范围并切分类。 */
  selectDiscovery: (f: PrDiscoveryFilter) => void;
  /** 切到「进行中」范围。 */
  viewActive: () => void;
  /** 切到「已关闭」范围（触发懒加载）。 */
  viewArchived: () => void;
  /** 按 URL 打开当前平台 PR（命令面板「打开 URL」）：定位本地或拉取存档后切到对应范围并选中；失败弹 toast。 */
  openPrByUrl: (url: string) => Promise<void>;
  /** 定位并选中某 PR（活跃命中切活跃 + 必要时切分类 + 标已读；否则视为已归档 → 切归档范围、加载归档列表后选中）。 */
  jumpToPr: (localId: string) => Promise<void>;
  pendingDiffNav: PendingDiffNav | null;
  setPendingDiffNav: Dispatch<SetStateAction<PendingDiffNav | null>>;
  pendingTab: 'activity' | null;
  setPendingTab: Dispatch<SetStateAction<'activity' | null>>;
}

/**
 * PR 导航 / 范围领域：在 {@link usePullRequests} 的列表 + 选中之上，统管发现分类、活跃 / 归档范围切换、
 * 归档冷存储懒加载、按 URL 打开、定位跳转（活跃 / 归档统一逻辑），并消费系统通知点击的导航意图
 * （`notification:activate` → jumpToPr + inline 评论跳 Diff 行 / summary 评论开「活动」标签）。
 *
 * 选中态 / 已读由 usePullRequests 拥有（经入参传入）；本 hook 只负责「去哪儿、看哪个范围」。
 */
export function usePrNavigation({
  prs,
  selectedId,
  setSelectedId,
  markRead,
  notifyError,
}: {
  prs: StoredPullRequest[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  markRead: (localId: string) => Promise<void> | void;
  notifyError: (text: string) => void;
}): PrNavigation {
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  const [scope, setScope] = useState<'active' | 'archived'>('active');
  const [archivedPrs, setArchivedPrs] = useState<StoredPullRequest[]>([]);
  // 归档冷存储拉取中：列表区据此显示 loading（归档规模大、可能慢；PaneLoading 自带 150ms 延迟，快路径不闪）。
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [pendingDiffNav, setPendingDiffNav] = useState<PendingDiffNav | null>(null);
  // 通知点击 summary 评论 → 请求 PrPanel 切到「活动」对话标签（inline 评论走 pendingDiffNav）。
  const [pendingTab, setPendingTab] = useState<'activity' | null>(null);

  // 进入「已关闭」范围时懒加载归档冷存储（每次进入重取，纳入此后新归档的 PR）；离开不清，便于来回切。
  useEffect(() => {
    if (scope !== 'archived') return;
    let cancelled = false;
    setArchivedLoading(true);
    void invoke('prs:listArchived', undefined)
      .then((list) => {
        if (!cancelled) setArchivedPrs(list);
      })
      .finally(() => {
        if (!cancelled) setArchivedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // 选发现分类（侧栏 tab / 命令面板）即回到「进行中」范围；「查看已关闭」切到归档范围。
  const selectDiscovery = useCallback((f: PrDiscoveryFilter) => {
    setScope('active');
    setDiscoveryFilter(f);
  }, []);
  const viewActive = useCallback(() => setScope('active'), []);
  const viewArchived = useCallback(() => setScope('archived'), []);

  // 当前发现分类的 ref：供 openPrByUrl / jumpToPr 在稳定回调里读最新值，免得把 discoveryFilter 进依赖、频繁重建。
  const discoveryFilterRef = useRef(discoveryFilter);
  discoveryFilterRef.current = discoveryFilter;

  const openPrByUrl = useCallback(
    async (url: string) => {
      try {
        const res = await invoke('prs:openByUrl', { url });
        setScope(res.location);
        if (res.location === 'archived') {
          // 归档范围（已存在归档 / 新拉取存档）需重载列表纳入目标 PR。
          setArchivedPrs(await invoke('prs:listArchived', undefined));
        } else if (
          // 活跃 PR：若当前发现分类不含它，落到包含它的分类，确保侧栏能展示并高亮（否则只剩详情显示、列表无选中）。
          res.discoveryFilters.length > 0 &&
          !res.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(res.discoveryFilters[0]!);
        }
        setSelectedId(res.localId);
        if (res.location === 'active') void markRead(res.localId);
      } catch (e) {
        notifyError(formatBackendError(e).title);
      }
    },
    [setSelectedId, markRead, notifyError],
  );

  // 活跃 PR 列表 ref：供通知点击 / 状态栏跳转在稳定回调里读最新值，免得把 prs 进依赖、频繁重建。
  const prsRef = useRef(prs);
  prsRef.current = prs;
  // 状态栏运行指示 / 通知点击 → 定位 PR。任务运行期间该 PR 可能已被 poll 归档（任务不取消、仍在跑），故活跃列表
  // 里找不到时视为已归档：切归档范围 + 重载归档列表（覆盖「本 tick 刚归档、缓存未含」与「已在归档范围、setScope
  // 同值不触发懒加载」两种情况）再选中。活跃命中则切活跃范围 + 必要时切到含它的发现分类（确保侧栏展示并高亮）+ 标已读。
  const jumpToPr = useCallback(
    async (localId: string) => {
      const active = prsRef.current.find((p) => p.localId === localId);
      if (active) {
        setScope('active');
        if (
          active.discoveryFilters.length > 0 &&
          !active.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(active.discoveryFilters[0]!);
        }
        setSelectedId(localId);
        void markRead(localId);
        return;
      }
      setScope('archived');
      setArchivedPrs(await invoke('prs:listArchived', undefined));
      setSelectedId(localId);
    },
    [markRead, setSelectedId],
  );

  // 系统通知点击 → 导航：复用 jumpToPr 选中目标，再按类型定位——inline 评论跳 Diff 行，summary 评论
  // （mention / reply）开「活动」标签，new_pr 仅选中。与状态栏跳转走同一套活跃 / 归档定位逻辑。
  useEffect(() => {
    return subscribe('notification:activate', ({ localId, kind, anchor }) => {
      void jumpToPr(localId);
      if (anchor) {
        setPendingDiffNav({ anchor: { path: anchor.path, startLine: anchor.line, endLine: anchor.line } });
      } else if (kind === 'mention' || kind === 'reply') {
        setPendingTab('activity');
      }
    });
  }, [jumpToPr]);

  // 列表 / 详情数据源随范围切换：已关闭范围用归档列表，其余用活跃列表。选中 PR 从当前展示列表解析——
  // 切到归档范围时若原选中是活跃 PR 则解析不到、详情区回落空态，选归档项后再展示其详情。
  const displayedPrs = scope === 'archived' ? archivedPrs : prs;
  const selectedPr = displayedPrs.find((p) => p.localId === selectedId) ?? null;

  return {
    scope,
    discoveryFilter,
    displayedPrs,
    selectedPr,
    archivedLoading,
    selectDiscovery,
    viewActive,
    viewArchived,
    openPrByUrl,
    jumpToPr,
    pendingDiffNav,
    setPendingDiffNav,
    pendingTab,
    setPendingTab,
  };
}
