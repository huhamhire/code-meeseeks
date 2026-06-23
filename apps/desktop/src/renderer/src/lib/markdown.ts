// 远端 markdown（PR 描述 / 评论）里常含原始 HTML —— 典型如 Qodo / pr-agent 机器人用
// <details> 折叠、<table>、<picture>/<img>、<sub>/<sup> 等 GitHub 风格 HTML。react-markdown
// 默认会丢弃原始 HTML，导致这类评论显示残缺。这里用 rehype-raw 解析 HTML，再用 rehype-sanitize
// 按白名单过滤（剔除 <script>、on* 事件、javascript: 链接等），既能渲染又不引入 XSS。
//
// 仅对**远端来源**的 markdown 启用（评论、PR 描述）；本地 / AI 生成的内容无需放开 HTML。
import type { Options } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

function extend<T>(list: readonly T[] | null | undefined, extra: readonly T[]): T[] {
  return Array.from(new Set<T>([...(list ?? []), ...extra]));
}

// 在 rehype-sanitize 的 GitHub 默认白名单基础上，补齐 Qodo 等机器人常用但默认未必放开的标签/属性。
const schema = {
  ...defaultSchema,
  // 放行 Bitbucket 评论的 `attachment:<repoId>/<id>` 内部协议（内嵌图片/附件引用）。
  // 默认 protocols 白名单 src/href 只许 http/https，会在 react-markdown 的 urlTransform
  // 之前就把 attachment: 的 src/href 整个剥掉 → img 收不到 src（BitbucketImage 不触发）、
  // a 收不到 href（渲染成裸文字）。两条附件渲染路径都被卡死，故在此显式放行 attachment 协议。
  protocols: {
    ...defaultSchema.protocols,
    src: extend(defaultSchema.protocols?.src, ['attachment']),
    href: extend(defaultSchema.protocols?.href, ['attachment']),
  },
  tagNames: extend(defaultSchema.tagNames, [
    'details',
    'summary',
    'picture',
    'source',
    'kbd',
    'samp',
    'ins',
    'abbr',
  ]),
  attributes: {
    ...defaultSchema.attributes,
    details: extend(defaultSchema.attributes?.details, ['open']),
    source: ['srcSet', 'media', 'type', 'sizes', 'src'],
    img: extend(defaultSchema.attributes?.img, ['align', 'width', 'height']),
    div: extend(defaultSchema.attributes?.div, ['align']),
    td: extend(defaultSchema.attributes?.td, ['align']),
    th: extend(defaultSchema.attributes?.th, ['align']),
    a: extend(defaultSchema.attributes?.a, ['rel', 'target']),
    '*': extend(defaultSchema.attributes?.['*'], ['align']),
  },
};

/** 远端 markdown 的 rehype 插件链：解析原始 HTML → 按白名单消毒。 */
export const REMOTE_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, schema],
];
