import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Modal, mermaidComponents } from '../../../common';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import type { MatchedRules } from '../types';

/**
 * 命中规则预览。单条沿用「Rule: <id>」标题；多条时标题改为计数，正文按 `Ruleset N` 分段逐条列出
 * （与评审注入的拼接口径一致），让用户确认本次 review 会被哪些规约约束。
 */
export function RulePreviewModal({
  rules,
  onClose,
}: {
  rules: MatchedRules;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const multi = rules.length > 1;
  return (
    <Modal
      size="sm"
      onClose={onClose}
      title={
        multi
          ? t('chatPane.rulePreviewTitleMulti', { n: rules.length })
          : t('chatPane.rulePreviewTitle', { id: rules[0]?.id ?? '' })
      }
      headerClose="text"
      ariaLabel={t('chatPane.rulePreviewAria')}
    >
      {rules.map((rule, i) => (
        <Fragment key={rule.id}>
          {multi && (
            <h3 className="chat-rule-preview-heading" style={{ marginTop: i === 0 ? 0 : 20 }}>
              Ruleset {i + 1}
            </h3>
          )}
          <div className="modal-kv">
            <div className="modal-kv-key">{t('chatPane.ruleFilePath')}</div>
            <div className="modal-kv-val">{rule.filePath}</div>
            <div className="modal-kv-key">priority</div>
            <div className="modal-kv-val">{rule.priority}</div>
            <div className="modal-kv-key">tools</div>
            <div className="modal-kv-val">{rule.tools.join(', ')}</div>
          </div>
          <div className="markdown" style={{ marginTop: 12 }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              rehypePlugins={REMOTE_REHYPE_PLUGINS}
              components={mermaidComponents}
            >
              {rule.instructions}
            </ReactMarkdown>
          </div>
        </Fragment>
      ))}
    </Modal>
  );
}
