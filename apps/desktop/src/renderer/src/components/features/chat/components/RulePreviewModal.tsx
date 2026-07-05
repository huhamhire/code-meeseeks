import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { FolderIcon, Modal, mermaidComponents } from '../../../common';
import { REMOTE_REHYPE_PLUGINS } from '../../../../lib/markdown';
import { invoke } from '../../../../api';
import type { MatchedRules } from '../types';

/**
 * Matched rule preview. A single match keeps the「Rule: <id>」title; multiple matches switch the title to a
 * count and list each in the body split by `Ruleset N` (matching the review injection's concatenation),
 * letting the user confirm which rules will constrain this review.
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
          : t('chatPane.rulePreviewTitle')
      }
      headerClose="text"
      headerActions={
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => void invoke('app:openAgentDir', undefined)}
          title={t('chatPane.ruleOpenAgentDir')}
          aria-label={t('chatPane.ruleOpenAgentDir')}
        >
          <FolderIcon />
        </button>
      }
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
            {/* Shown relative to the Agent dir (`rules/<id>`), to avoid exposing the long machine absolute path; the open-dir button is provided uniformly in the title bar. */}
            <div className="modal-kv-val">
              <code>rules/{rule.id}</code>
            </div>
            <div className="modal-kv-key">{t('chatPane.rulePriority')}</div>
            <div className="modal-kv-val">{rule.priority}</div>
            <div className="modal-kv-key">{t('chatPane.ruleTools')}</div>
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
