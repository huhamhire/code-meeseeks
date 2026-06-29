import { reactionCodeToEmoji } from '@meebox/shared';

/** mdast 节点的最小结构（仅取本插件用到的字段，避免引入 mdast 类型依赖）。 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

// `:shortcode:`：字母 / 数字 / _ / + / -（覆盖 gemoji 风格名，如 tada / +1 / heart_eyes）。
const SHORTCODE = /:([a-z0-9_+-]{1,40}):/gi;

/**
 * remark 插件：把评论正文里的 `:shortcode:`（如 `:tada:` → 🎉）替换为对应 emoji 字符，复用内置精选集
 * （{@link reactionCodeToEmoji}，含 `+1`/`-1` 别名）。
 *
 * 只改写 mdast `text` 节点——代码（inlineCode / code 块）的内容不在 text 节点里，故天然跳过，
 * `def f(x):` / `http://h:8080` 等不会被误伤；内置集外的未知 shortcode 原样保留（部分渲染、与精选集
 * 路线一致）。emoji 是纯文本，直接就地替换字符串、无需拆分节点。
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
