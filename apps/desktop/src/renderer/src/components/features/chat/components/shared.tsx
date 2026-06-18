import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { QuestionIcon } from '../../../common/icons';
import { mermaidComponents } from '../../../common/markdownMermaid';
import { REMOTE_REHYPE_PLUGINS } from '../../../../markdown';
import { parseAnsi, segmentStyle } from '../../../../utils/ansi';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Bullet({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="chat-empty-bullet" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

/** chat 区统一的 markdown 渲染（与 finding 卡片同套 remark/rehype 配置）。 */
export function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={REMOTE_REHYPE_PLUGINS}
      components={mermaidComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

/** 行内 markdown：用于标题等单行文本，渲染内联代码 / 强调，去掉块级 <p> 包裹保持行内排版。 */
export function MdInline({ children }: { children: string }) {
  // 标题以「2. 」「- 」这类列表标记开头时，markdown 会把它解析成 <ol>/<ul> 块塞进 <h4>，撑破内联布局
  // 并溢出。转义行首列表标记，按字面渲染序号 / 符号（保留文字），不再生成列表块。
  const inlineSafe = children
    .replace(/^(\s*)(\d+)\.(\s)/, '$1$2\\.$3')
    .replace(/^(\s*)([-*+])(\s)/, '$1\\$2$3');
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={REMOTE_REHYPE_PLUGINS}
      components={{ p: ({ children }) => <>{children}</> }}
    >
      {inlineSafe}
    </ReactMarkdown>
  );
}

/**
 * 代码路径折行优化：在分隔符 `/` 与连接符 `.` `_` `-` 之后插入 <wbr> 软断点，配合 CSS
 * `word-break: normal`，让长路径优先按这些字符折断（而非从单词中间断开），保证可读性。
 */
export function BreakablePath({ path }: { path: string }) {
  const parts = path.split(/(?<=[/._-])/);
  const nodes: ReactNode[] = [];
  parts.forEach((p, i) => {
    nodes.push(p);
    if (i < parts.length - 1) nodes.push(<wbr key={`wbr-${i}`} />);
  });
  return <>{nodes}</>;
}

/** 把含 ANSI 转义的 stdout 文本渲染成带颜色的 <pre>。空文本时显示占位 */
export function AnsiPre({
  className,
  text,
  preRef,
  placeholder,
}: {
  className?: string;
  text: string;
  preRef?: Ref<HTMLPreElement>;
  placeholder?: string;
}) {
  if (!text) {
    return (
      <pre className={className} ref={preRef}>
        {placeholder ?? ''}
      </pre>
    );
  }
  const segments = parseAnsi(text);
  return (
    <pre className={className} ref={preRef}>
      {segments.map((seg, i) => (
        <span key={i} style={segmentStyle(seg)}>
          {seg.text}
        </span>
      ))}
    </pre>
  );
}

/** /ask 提问行：问号图标 + markdown 渲染的提问内容（Agent 自拟的追问常含内联代码 / 列表）。 */
export function AskQuestion({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="chat-user-msg" aria-label={t('chatPane.userQuestionAria')}>
      <QuestionIcon />
      <div className="markdown chat-user-msg-body">
        <Md>{text}</Md>
      </div>
    </div>
  );
}
