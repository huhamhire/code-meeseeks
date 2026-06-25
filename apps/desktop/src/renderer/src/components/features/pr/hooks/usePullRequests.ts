import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../api';
import { formatBackendError } from '../../../../errors';

/**
 * PR 列表生命周期与详情动作（领域内聚）：列表 state + 选中态、读缓存 reload / 拉远端 refresh、
 * 审批状态决断、合并。不感知 boot/连接（选中连接的反查由 App 持 boot 派生；启动 / 焦点刷新由
 * useBootstrap 经 reloadPrs 驱动），仅依赖 notifyError 弹操作级错误。
 */
export function usePullRequests({ notifyError }: { notifyError: (msg: string) => void }) {
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

  // 标记 PR 已读：用户打开 PR 时调用。先乐观清掉本地未读圆点（即时反馈），再持久化已读水位——
  // 下一轮 poll 不会因旧事件把它标回。每次选中都发 IPC：打开 PR 非高频，且推进已读水位本就是对的；
  // 不靠 setState 更新器的副作用判断「是否未读」——更新器在渲染阶段才跑，同步读其副作用拿不到结果。
  const markRead = useCallback(async (localId: string): Promise<void> => {
    setPrs((prev) =>
      prev.map((p) => (p.localId === localId && p.unread ? { ...p, unread: false } : p)),
    );
    try {
      await invoke('prs:markRead', { localId });
    } catch (e) {
      console.error('markRead failed', e);
    }
  }, []);

  const selected = prs.find((p) => p.localId === selectedId) ?? null;

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
      // 合并失败（PR 已合并 / 冲突 / veto / 权限）→ 弹 toast，本地不变。先经 formatBackendError 解码
      // AppError 错误码做 i18n（如 EPR0003「已被合并」给友好提示），非编码错误回退原始 message。
      notifyError(t('app.mergeFailed', { msg: formatBackendError(e).title }));
      void triggerRefresh();
      return;
    } finally {
      setMerging(false);
    }
    // 合并成功：PR 已转 MERGED，会从 pending 列表退场。取消选中 + 刷新让其消失
    if (selectedId === mergedId) setSelectedId(null);
    await triggerRefresh();
  }, [selected, selectedId, triggerRefresh, notifyError, merging, t]);

  return {
    prs,
    setPrs,
    selectedId,
    setSelectedId,
    selected,
    refreshing,
    merging,
    reloadPrs,
    triggerRefresh,
    setSelectedPrStatus,
    mergeSelectedPr,
    markRead,
  };
}
