/**
 * 不同代码托管平台对 inline comment 允许的"锚定行范围"差异较大：
 *
 * - Bitbucket Server / Data Center: 严格 — `/comments` 接口要求 anchor.line
 *   落在 diff hunk 范围内（含 context 行）。锚到 hunk 之外的行 Bitbucket 直接 400。
 * - GitHub / GitLab: 宽松 — diff 视图内任意行都能起评论
 *   （GitHub 多文件 review comment 也是按 file:line 锚定但范围更宽松）。
 *
 * 把"哪一行能新增内联评论"抽象成 platform-specific policy，让 DiffView 渲染行
 * hover '+' glyph 时按当前 PR 的 platform 选 profile 过滤；后续 Bitbucket publishInline
 * 提交时也复用同一份规则做前置校验，避免 400。
 *
 * Hunk 信息来自 monaco DiffEditor 的 getLineChanges()，不依赖额外 IPC：
 * - ILineChange.{original,modified}{Start,End}LineNumber → DiffHunkRange
 * - 转换在 DiffView 里就近做，policy 只接受归一化结构
 */
import type { PlatformKind } from './platform.js';

/**
 * 单个 diff hunk 在 original / modified 两侧的行范围。inclusive。
 * - modified=null：纯删除（modified 侧没有对应行）
 * - original=null：纯新增（original 侧没有对应行）
 */
export interface DiffHunkRange {
  modified: { start: number; end: number } | null;
  original: { start: number; end: number } | null;
}

export interface InlineCommentPolicy {
  /** Profile 显示名，hover '+' 被禁用时 tooltip 可以引用 */
  label: string;
  /**
   * 判断 (side, line) 是否允许新增 inline comment。hunks 是全文件的变更范围列表。
   * 注意：策略只看 anchor 行能否落点，不管"已有评论 / 草稿占用"那一档；占用判断
   * 仍在 DiffView 的 occupied set 里做
   */
  isLineAllowed(
    hunks: ReadonlyArray<DiffHunkRange>,
    side: 'old' | 'new',
    line: number,
  ): boolean;
}

/**
 * 工厂：以"hunk 范围 ± context 行"为允许行的 policy。context=0 时严格 hunk 内；
 * Bitbucket 实测允许变更上下 10 行（含 context 行）可加评论
 */
function makeContextRangePolicy(label: string, context: number): InlineCommentPolicy {
  return {
    label,
    isLineAllowed(hunks, side, line) {
      for (const h of hunks) {
        const range = side === 'new' ? h.modified : h.original;
        if (range && line >= range.start - context && line <= range.end + context) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Bitbucket profile：允许变更区域**上下 10 行**内的行 (跟 Bitbucket Web UI 行为对齐 — 离 hunk
 * 太远的行 /comments 接口直接 400)。新增行 (modified 侧) 锚到 modified range，
 * 删除行 (original 侧) 锚到 original range。Bitbucket 的 fileType=FROM/TO 字段后续在
 * publishInline 时根据 side 翻译
 */
const bitbucketPolicy = makeContextRangePolicy(
  'Bitbucket Server: 变更上下 10 行内可加评论',
  10,
);

/** 宽松 profile：任意行允许（GitHub / GitLab） */
const permissivePolicy: InlineCommentPolicy = {
  label: '任意行可加评论',
  isLineAllowed: () => true,
};

export const INLINE_COMMENT_POLICIES: Readonly<Record<PlatformKind, InlineCommentPolicy>> = {
  'bitbucket-server': bitbucketPolicy,
  github: permissivePolicy,
  gitlab: permissivePolicy,
};

/** 平台值未知时回退宽松 policy，避免新平台接入时把 + 全屏蔽 */
export function policyForPlatform(platform: PlatformKind): InlineCommentPolicy {
  return INLINE_COMMENT_POLICIES[platform] ?? permissivePolicy;
}
