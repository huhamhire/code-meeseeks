import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { REMOTE_REHYPE_PLUGINS } from '../../../../../lib/markdown';
import { remarkEmojiShortcodes } from '../../../../../lib/remark-emoji';
import { transformBitbucketUrl } from '../../../../common';

/**
 * Comment body markdown rendering boilerplate: the comments/activity tab and the diff inline comment zone share the same
 * remark / rehype / urlTransform config, only `components` (each's img / a / mermaid overrides) and the outer
 * `className` (`pr-comment-body` / `comment-zone-body`) are passed in by the caller, kept independent.
 *
 * hardBreaks (Bitbucket / GitHub) attaches remarkBreaks to turn a single `\n` → `<br>`; GitLab uses standard CommonMark
 * (single `\n` = space) and doesn't attach it, aligned with each's web rendering.
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
