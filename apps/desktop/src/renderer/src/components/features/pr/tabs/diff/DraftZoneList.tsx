import { useTranslation } from 'react-i18next';
import type { ReviewDraft } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { formatBackendError } from '../../../../../errors';
import { DraftZone } from '../drafts/DraftZone';

/**
 * 同行多条草稿的容器；每条独立 DraftZone (read/edit 各自维护)，组件间用 hr 分隔。
 * onSave / onDelete 在这里调 IPC drafts:update / drafts:delete；写盘后 main 端
 * 广播 drafts:changed 事件 → drafts-store 重拉 → DiffView 顶层 useEffect 重建
 * zones (此组件随之 unmount/remount)。
 */
export function DraftZoneList({
  drafts,
  prLocalId,
  registerEditTrigger,
  hardBreaks,
}: {
  drafts: ReviewDraft[];
  prLocalId: string;
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  hardBreaks: boolean;
}) {
  const { t } = useTranslation();
  const onSave = async (draftId: string, body: string): Promise<void> => {
    await invoke('drafts:update', {
      localId: prLocalId,
      draftId,
      patch: { body },
    });
  };
  const onDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: prLocalId, draftId });
  };
  // 单条发布：复用 drafts:publishBatch handler，传 [draftId] 单元素。这样跟
  // PublishReviewModal 的批量路径共用同一份 main 端逻辑 (anchor 映射 / posted
  // 回写 / force-refresh 评论 / 失败收集都一致)，行为可预测，未来改任一处不会
  // 让两条路径分叉
  const onPublish = async (draftId: string): Promise<{ ok: boolean; error?: string }> => {
    const resp = await invoke('drafts:publishBatch', {
      localId: prLocalId,
      draftIds: [draftId],
    });
    const r = resp.results[0];
    if (!r) return { ok: false, error: t('diffView.noResultFromMain') };
    // r.error 是 AppError 编码串（草稿域 EPR* / 发布异常），在此解码为本地化文案再上交展示。
    return { ok: r.ok, error: r.error ? formatBackendError(r.error).title : undefined };
  };
  return (
    <div className="draft-zone-list">
      {drafts.map((d, i) => (
        <div key={d.id} className={`draft-zone-item${i > 0 ? ' draft-zone-item-divider' : ''}`}>
          <DraftZone
            draft={d}
            hardBreaks={hardBreaks}
            registerEditTrigger={registerEditTrigger}
            onSave={(body) => onSave(d.id, body)}
            onDelete={() => onDelete(d.id)}
            onPublish={() => onPublish(d.id)}
          />
        </div>
      ))}
    </div>
  );
}
