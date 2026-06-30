import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { REMOTE_REHYPE_PLUGINS } from '../../../../../lib/markdown';
import { remarkEmojiShortcodes } from '../../../../../lib/remark-emoji';
import { transformBitbucketUrl } from '../../../../common';

/**
 * 评论正文 markdown 渲染样板：评论/活动 tab 与 diff 行内评论 zone 共用同一套
 * remark / rehype / urlTransform 配置，仅 `components`（各自的 img / a / mermaid 覆盖）与外层
 * `className`（`pr-comment-body` / `comment-zone-body`）由调用方传入，互不收敛。
 *
 * hardBreaks（Bitbucket / GitHub）挂 remarkBreaks 让单 `\n` → `<br>`；GitLab 走标准 CommonMark
 * （单 `\n` = 空格）不挂，与各自 web 渲染对齐。
 */
export function CommentMarkdown({
  body,
  hardBreaks,
  components,
  className,
}: {
  body: string;
  hardBreaks: boolean;
  components: Parameters<typeof ReactMarkdown>[0]['components'];
  className: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={
          hardBreaks
            ? [remarkGfm, remarkBreaks, remarkEmojiShortcodes]
            : [remarkGfm, remarkEmojiShortcodes]
        }
        rehypePlugins={REMOTE_REHYPE_PLUGINS}
        components={components}
        urlTransform={transformBitbucketUrl}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
