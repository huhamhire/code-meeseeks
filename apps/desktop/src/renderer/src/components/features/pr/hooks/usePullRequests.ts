import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionSummary, LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../api';

interface UsePullRequestsParams {
  /** 已加载的连接摘要（用于反查选中 PR 所属连接的能力位 / 当前用户）。 */
  connections: ConnectionSummary[] | undefined;
  /** 应用是否已 bootstrap 完成；false 时不挂 focus 刷新（尚无连接 / PR 可刷）。 */
  ready: boolean;
  /** 操作级错误提示（审批 / 合并失败弹 toast）。 */
  notifyError: (msg: string) => void;
}

/**
 * PR 列表生命周期与详情动作（领域内聚）：列表 state + 选中态、读缓存 reload / 拉远端 refresh、
 * 审批状态决断、合并，以及窗口重获焦点时的主动刷新。App 仅在 bootstrap / 向导完成时经 setPrs
 * 注入初始列表、在 poll tick 时调 reloadPrs，其余 PR 业务都归这里。
 */
export function usePullRequests({ connections, ready, notifyError }: UsePullRequestsParams) {
  const { t } = useTranslation();
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 合并进行中：GitHub 合并可能较慢（异步算 mergeable），按钮置等待态并防重复点击。
  const [merging, setMerging] = useState(false);

  const reloadPrs = useCallback(async (): Promise<void> => {
    const fresh = await invoke('prs:list', undefined);
    setPrs(fresh);
  }, []);

  const triggerRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await invoke('prs:refresh', undefined);
      await reloadPrs();
    } catch (e) {
      console.error('refresh failed', e);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, reloadPrs]);

  const selected = prs.find((p) => p.localId === selectedId) ?? null;
  // 选中 PR 所属连接的能力位 + 当前 PAT 用户（多平台降级：审批按钮显隐 / 自己 PR 灰显）
  const selectedConn = selected
    ? connections?.find((c) => c.connectionId === selected.connectionId)
    : undefined;

  const setSelectedPrStatus = useCallback(
    async (status: LocalPrStatus): Promise<void> => {
      if (!selected) return;
      try {
        const updated = await invoke('prs:setLocalStatus', { localId: selected.localId, status });
        if (updated) {
          setPrs((prev) => prev.map((p) => (p.localId === updated.localId ? updated : p)));
        }
      } catch (e) {
        // 远端拒绝（如 PR 已关闭 / 合并 / 权限不足）→ 本地状态不变，弹 toast 提示。
        // 顺手刷新一次：PR 若已关闭，下一轮 poll 会把它软删，列表自洽
        const msg = e instanceof Error ? e.message : String(e);
        notifyError(t('app.approveActionFailed', { msg }));
        void triggerRefresh();
      }
    },
    [selected, notifyError, triggerRefresh, t],
  );

  const mergeSelectedPr = useCallback(async (): Promise<void> => {
    if (!selected || merging) return;
    const mergedId = selected.localId;
    setMerging(true);
    try {
      await invoke('prs:merge', { localId: mergedId });
    } catch (e) {
      // 合并失败（冲突 / veto / 权限 / PR 已关闭）→ 弹 toast，本地不变
      const msg = e instanceof Error ? e.message : String(e);
      notifyError(t('app.mergeFailed', { msg }));
      void triggerRefresh();
      return;
    } finally {
      setMerging(false);
    }
    // 合并成功：PR 已转 MERGED，会从 pending 列表退场。取消选中 + 刷新让其消失
    if (selectedId === mergedId) setSelectedId(null);
    await triggerRefresh();
  }, [selected, selectedId, triggerRefresh, notifyError, merging, t]);

  // 窗口重新获得焦点时主动 refresh 远端：拉 PR meta，Bitbucket 上加 comment / 改状态后
  // PR.updatedAt 跳变 → PrPanel useEffect 的 prUpdatedAt dep 触发 → force listComments 拉新评论。
  useEffect(() => {
    if (!ready) return;
    const onFocus = (): void => {
      void (async () => {
        try {
          await invoke('prs:refresh', undefined);
          await reloadPrs();
        } catch {
          // 静默：focus 触发的刷新失败不该弹错给用户
        }
      })();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [ready, reloadPrs]);

  return {
    prs,
    setPrs,
    selectedId,
    setSelectedId,
    selected,
    selectedConn,
    refreshing,
    merging,
    reloadPrs,
    triggerRefresh,
    setSelectedPrStatus,
    mergeSelectedPr,
  };
}
