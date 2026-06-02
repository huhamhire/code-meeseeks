/**
 * 单条规则，从 rules.dir 下的某个 .md 文件加载得到。
 * frontmatter 是 yaml，body 是 markdown 正文（最终作为 extra_instructions 注给 pr-agent）。
 *
 * 设计原则：
 * - 每个字段都给宽松默认（缺省 = 匹配任意 / 启用 / 不打标签）。规则文件可以只写 body
 *   不写 frontmatter，效果是全局生效的"基础规约"。
 * - applies_to.* 的值是**正则源串**，加载时转 RegExp，匹配时 .test() 字段值。
 *   字段缺省 → 匹配任意。
 * - 同一次 pragent:run 可能有多条规则命中；调用方按 priority desc + filePath asc
 *   排序后**只取第一条**（pickMatchingRule）。多规则拼接的复杂语义留到后续按需扩展。
 */
export type RuleTool = 'describe' | 'review';

export interface RuleApplies {
  /** BBS projectKey 正则，例如 "^FX$" 或 "^FX-.*" */
  project?: RegExp;
  /** BBS repoSlug 正则，例如 "^fx-.*" */
  repo?: RegExp;
  /** PR base 分支显示名正则，例如 "^(master|main)$" */
  target_branch?: RegExp;
}

export interface Rule {
  /** 文件相对 rules.dir 的路径 (含 .md)，作 id + UI 展示 + 排序 tie-break */
  id: string;
  /** 文件绝对路径，调用方需要展示 / 跳转时用 */
  filePath: string;
  applies_to: RuleApplies;
  /** 缺省值是 `['review']`：规则语义偏代码评审，给 /describe 注入约束容易让描述偏题 */
  tools: ReadonlyArray<RuleTool>;
  /** 命中后给 pr-agent custom_labels (P0 暂不接入，先解析存储) */
  custom_labels: ReadonlyArray<string>;
  /** 同时命中多条时按 priority desc 排序；默认 0 */
  priority: number;
  /** 是否启用，false 时 loadRules 仍会读入但 pickMatchingRule 会跳过 */
  enabled: boolean;
  /** markdown body，作为 extra_instructions 注给 pr-agent */
  instructions: string;
}

export interface RuleMatchContext {
  projectKey: string;
  repoSlug: string;
  /** PR base ref displayId (master / main / develop / ...) */
  targetBranch: string;
  tool: RuleTool;
}
