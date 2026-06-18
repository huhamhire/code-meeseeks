import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Modal } from '../../../common/Modal';
import { mermaidComponents } from '../../../common/markdownMermaid';
import { REMOTE_REHYPE_PLUGINS } from '../../../../markdown';
import type { MatchedRule } from '../types';

export function RulePreviewModal({
  rule,
  onClose,
}: {
  rule: NonNullable<MatchedRule>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      size="sm"
      onClose={onClose}
      title={t('chatPane.rulePreviewTitle', { id: rule.id })}
      headerClose="text"
      ariaLabel={t('chatPane.rulePreviewAria')}
    >
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
    </Modal>
  );
}
