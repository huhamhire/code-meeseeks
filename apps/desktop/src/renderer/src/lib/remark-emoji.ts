import { reactionCodeToEmoji } from '@meebox/shared';

/** Minimal shape of an mdast node (only the fields this plugin uses, avoiding an mdast type dependency). */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

// `:shortcode:`: letters / digits / _ / + / - (covers gemoji-style names, like tada / +1 / heart_eyes).
const SHORTCODE = /:([a-z0-9_+-]{1,40}):/gi;

/**
 * remark plugin: replace `:shortcode:` in comment bodies (like `:tada:` → 🎉) with the corresponding emoji
 * character, reusing the built-in curated set ({@link reactionCodeToEmoji}, including `+1`/`-1` aliases).
 *
 * Only rewrites mdast `text` nodes — the contents of code (inlineCode / code blocks) aren't in text nodes, so they're
 * naturally skipped, and `def f(x):` / `http://h:8080`, etc. won't be hit by mistake; unknown shortcodes outside the
 * built-in set are kept as-is (partial rendering, consistent with the curated-set approach). emoji are plain text,
 * so replace the string in place directly, no need to split nodes.
 */
export function remarkEmojiShortcodes() {
  return (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      if (node.type === 'text' && typeof node.value === 'string' && node.value.includes(':')) {
        node.value = node.value.replace(
          SHORTCODE,
          (whole, code: string) => reactionCodeToEmoji(code.toLowerCase()) ?? whole,
        );
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
