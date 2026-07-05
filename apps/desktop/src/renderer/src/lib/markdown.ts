// Remote markdown (PR descriptions / comments) often contains raw HTML — typically GitHub-style HTML like Qodo /
// pr-agent bots' <details> folds, <table>, <picture>/<img>, <sub>/<sup>, etc. react-markdown drops raw HTML by
// default, leaving such comments rendered incompletely. Here rehype-raw parses the HTML, then rehype-sanitize
// filters it by an allowlist (stripping <script>, on* events, javascript: links, etc.), rendering it without
// introducing XSS.
//
// Enabled only for **remote-sourced** markdown (comments, PR descriptions); local / AI-generated content needs no HTML.
import type { Options } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

function extend<T>(list: readonly T[] | null | undefined, extra: readonly T[]): T[] {
  return Array.from(new Set<T>([...(list ?? []), ...extra]));
}

// On top of rehype-sanitize's GitHub default allowlist, add tags/attributes commonly used by bots like Qodo but not necessarily allowed by default.
const schema = {
  ...defaultSchema,
  // Allow Bitbucket comments' `attachment:<repoId>/<id>` internal protocol (inline image/attachment references).
  // The default protocols allowlist only permits http/https for src/href, and would strip attachment:'s src/href
  // entirely before react-markdown's urlTransform → img gets no src (BitbucketImage doesn't fire), a gets no href
  // (rendered as bare text). Both attachment render paths are dead-ended, so explicitly allow the attachment protocol here.
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

/** rehype plugin chain for remote markdown: parse raw HTML → sanitize by allowlist. */
export const REMOTE_REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, schema],
];
