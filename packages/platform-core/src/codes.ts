// 平台层统一后台状态码：后台只发**稳定中性码**、不拼面向用户的本地化文案，本地化由前端按码做
// （见 docs/arch/01-platform-adapter.md §2 与 docs/arch/12-error-codes.md）。
// 各平台适配器把自身原生状态归一到这些码；前端按码 i18n（renderer locales 的 `mergeVeto.<code>`）。

/** 合并否决原因码（GitHub mergeable_state / GitLab detailed_merge_status 等归一到此）。 */
export const MERGE_VETO_CODES = [
  /** 存在合并冲突。 */
  'conflict',
  /** 被分支保护阻止（必需评审 / 必需检查未通过）。 */
  'branchProtected',
  /** 落后于目标分支，需先更新 / rebase。 */
  'behind',
  /** 必需检查未通过 / CI 进行中。 */
  'checksFailed',
  /** 可合并状态计算中。 */
  'checking',
  /** 草稿 / WIP，需标记为可合并。 */
  'draft',
  /** 存在未解决的讨论。 */
  'discussionsUnresolved',
  /** 审批未满足要求。 */
  'notApproved',
  /** PR / MR 非打开状态。 */
  'notOpen',
  /** 被其它合并请求阻塞。 */
  'blockedByDependency',
  /** 远端判定当前不可合并（其它 / 未细分原因）。 */
  'notMergeable',
] as const;

export type MergeVetoCode = (typeof MERGE_VETO_CODES)[number];
