import { findMentions } from '@meebox/shared';

/** Minimal shape of an mdast node (only the fields this plugin uses, avoiding an mdast type dependency). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The class the rendered pill carries; must stay in sync with the sanitize allowlist in lib/markdown.ts. */
export const MENTION_CLASS = 'comment-mention';

/** Split one text value into text / mention nodes, or null when it holds no mention (the common case — keep the node). */
function splitMentions(text: string): MdNode[] | null {
  const found = findMentions(text);
  if (found.length === 0) return null;
  const out: MdNode[] = [];
  let last = 0;
  for (const { start, end, name } of found) {
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({
      type: 'mention',
      // A node type mdast does not know: mdast-util-to-hast's unknown handler builds an element from the children and
      // applies hName / hProperties, which is the documented way to emit custom markup from a remark plugin.
      data: { hName: 'span', hProperties: { className: MENTION_CLASS } },
      // The pill shows `@name`, not the raw token: Bitbucket's quoted form (`@"first.last"`) carries quotes that are
      // platform syntax, not part of anyone's name, and showing them inside the pill is noise. This is the one place
      // the rendered text intentionally differs from the source — everything else is styling only.
      children: [{ type: 'text', value: `@${name}` }],
    });
    last = end;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/**
 * remark plugin: render `@mention` tokens in a comment body as a pill instead of leaving them as running text, so a
 * mention reads as "a person" at a glance rather than as prose that happens to start with `@`.
 *
 * Only mdast `text` nodes are rewritten, so code spans and code blocks are untouched for free — their content never
 * lives in text nodes, meaning an `@Override` in a snippet or an email in a fenced block stays literal. Which runs
 * count as mentions is decided by `findMentions` in shared, the reading counterpart of the `formatMention` used by the
 * editors, so the two directions cannot disagree about the syntax (notably Bitbucket's quoted `@"first.last"`).
 */
export function remarkMentions() {
  return (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      if (!node.children) return;
      const out: MdNode[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === 'text' && child.value?.includes('@')) {
          const parts = splitMentions(child.value);
          if (parts) {
            out.push(...parts);
            changed = true;
            continue;
          }
        } else {
          walk(child);
        }
        out.push(child);
      }
      if (changed) node.children = out;
    };
    walk(tree);
  };
}
