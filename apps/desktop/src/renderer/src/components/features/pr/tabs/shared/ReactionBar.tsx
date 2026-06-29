import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REACTION_PICKER, type PrComment } from '@meebox/shared';
import { invoke } from '../../../../../api';

/**
 * 评论 emoji 反应条：展示已有反应（emoji + 计数，自己反应过的高亮）+ 一个「加反应」按钮，点击展开
 * {@link REACTION_PICKER} 候选行就地切换。仅在平台 `commentReactions` 能力为真时由 CommentItem 渲染。
 *
 * 切换经 `comments:toggleReaction` 写远端，成功后 main 广播 comments:changed → 评论列表重拉刷新反应
 * （本组件不本地维护乐观态，保持与编辑/删除一致的「写后重拉」模型）。busy 期间禁用避免重复点击。
 * readOnly（归档 / 不可参与 PR）下仅展示已有反应、不提供切换入口；无反应则整块不渲染。
 */
export function ReactionBar({
  prLocalId,
  comment,
  readOnly = false,
}: {
  prLocalId: string;
  comment: PrComment;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reactions = comment.reactions ?? [];
  // GitHub 据 kind 选 issue / review 反应端点；其余平台忽略。anchor 兜底（旧数据无 kind）。
  const kind: 'summary' | 'inline' = comment.kind ?? (comment.anchor ? 'inline' : 'summary');

  if (readOnly && reactions.length === 0) return null;

  const toggle = async (emoji: string, add: boolean): Promise<void> => {
    if (busy || readOnly) return;
    setBusy(true);
    try {
      await invoke('comments:toggleReaction', {
        localId: prLocalId,
        commentId: comment.remoteId,
        kind,
        emoji,
        add,
      });
    } catch {
      // 失败静默：列表不会因 comments:changed 刷新出新反应，状态保持原样
    } finally {
      setBusy(false);
      setPickerOpen(false);
    }
  };

  return (
    <div className="pr-reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`pr-reaction${r.mine ? ' pr-reaction-mine' : ''}`}
          disabled={readOnly || busy}
          onClick={() => void toggle(r.emoji, !r.mine)}
          title={t(r.mine ? 'reactions.removeTitle' : 'reactions.addTitle', { emoji: r.emoji })}
        >
          <span className="pr-reaction-emoji">{r.emoji}</span>
          <span className="pr-reaction-count">{r.count}</span>
        </button>
      ))}
      {!readOnly && (
        <div className="pr-reaction-add-wrap">
          <button
            type="button"
            className="pr-reaction-add"
            disabled={busy}
            onClick={() => setPickerOpen((o) => !o)}
            title={t('reactions.pickTitle')}
            aria-label={t('reactions.pickTitle')}
          >
            <span aria-hidden="true">☺</span>
            <span className="pr-reaction-add-plus" aria-hidden="true">
              +
            </span>
          </button>
          {pickerOpen && (
            <div className="pr-reaction-picker" role="menu">
              {REACTION_PICKER.map((emoji) => {
                const mine = reactions.find((r) => r.emoji === emoji)?.mine ?? false;
                return (
                  <button
                    key={emoji}
                    type="button"
                    className={`pr-reaction-pick${mine ? ' pr-reaction-mine' : ''}`}
                    disabled={busy}
                    onClick={() => void toggle(emoji, !mine)}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
