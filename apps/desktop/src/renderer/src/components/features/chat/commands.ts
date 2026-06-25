import type { LocalPrStatus, ReviewRunTool } from '@meebox/shared';

/** 槽位定义：键盘操作 / 命令按钮 / 自动补全菜单都从这里取 */
/**
 * Chat 命令分三类：
 *  - 'pragent': pr-agent 工具 (review / describe / ask)，触发 pragent:run
 *  - 'review-action': PR review 决断 (approve / needswork)，写 Bitbucket reviewer status
 *    通过 prs:setLocalStatus 触发，跟 PR header 按钮共用同一路径
 *  - 'pr-action': PR 远端动作 (merge)，触发 prs:merge，跟 PR header 合并按钮共用同一路径；
 *    仅 mergeStatus.canMerge 时可用，输入栏会弹二次确认
 */
export type CommandSpec =
  | {
      kind: 'pragent';
      name: ReviewRunTool;
      label: string;
      /** i18n key (chatPane 命名空间) 解析命令描述，渲染时用 t(descKey) */
      descKey: string;
      insertAs: string;
    }
  | {
      kind: 'review-action';
      name: 'approve' | 'needswork';
      label: string;
      /** i18n key (chatPane 命名空间) 解析命令描述，渲染时用 t(descKey) */
      descKey: string;
      insertAs: string;
      reviewStatus: LocalPrStatus;
    }
  | {
      kind: 'pr-action';
      name: 'merge';
      label: string;
      /** i18n key (chatPane 命名空间) 解析命令描述，渲染时用 t(descKey) */
      descKey: string;
      insertAs: string;
    };

// 分组顺序：pr-agent 工具 → 分隔线 → review 决断
export const COMMANDS: ReadonlyArray<CommandSpec> = [
  // pr-agent
  {
    kind: 'pragent',
    name: 'review',
    label: '/review',
    descKey: 'chatPane.cmdReviewDesc',
    insertAs: '/review',
  },
  {
    kind: 'pragent',
    name: 'describe',
    label: '/describe',
    descKey: 'chatPane.cmdDescribeDesc',
    insertAs: '/describe',
  },
  // /improve：shim 强制 gfm_markdown=True 后，improve 走「汇总建议 → publish_comment →
  // review.md」路径（非 committable，inline 模式仍不可用），parse-output 按
  // generate_summarized_suggestions 的 <details> 模板解析出带重要度评分的 finding。
  {
    kind: 'pragent',
    name: 'improve',
    label: '/improve',
    descKey: 'chatPane.cmdImproveDesc',
    insertAs: '/improve',
  },
  {
    kind: 'pragent',
    name: 'ask',
    label: '/ask',
    descKey: 'chatPane.cmdAskDesc',
    insertAs: '/ask ',
  },
  // review 决断 (跟 PR header 按钮共用 prs:setLocalStatus，写 Bitbucket reviewer status)
  {
    kind: 'review-action',
    name: 'approve',
    label: '/approve',
    descKey: 'chatPane.cmdApproveDesc',
    insertAs: '/approve',
    reviewStatus: 'approved',
  },
  {
    kind: 'review-action',
    name: 'needswork',
    label: '/needswork',
    descKey: 'chatPane.cmdNeedsworkDesc',
    insertAs: '/needswork',
    reviewStatus: 'needs_work',
  },
  // PR 远端动作：合并（跟 PR header 合并按钮共用 prs:merge）。仅 canMerge 时在输入栏可见，弹二次确认。
  {
    kind: 'pr-action',
    name: 'merge',
    label: '/merge',
    descKey: 'chatPane.cmdMergeDesc',
    insertAs: '/merge',
  },
];
