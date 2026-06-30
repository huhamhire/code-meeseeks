# 规则系统

## 职责与边界

让评审带上团队/仓库的编码规约：存储用户写的规则、按 PR 上下文匹配、把命中规则注入 pr-agent 的
`extra_instructions`。

负责：规则加载/匹配/注入。不负责：pr-agent 调用（见 [pr-agent 运行时](05-pragent-runtime.md)）、规则正文怎么写（用户的事）。

## 核心设计

- **规则目录归于 Agent 目录 `<agent.dir>/rules/`**：规则正文是 Agent 知识来源的一部分，随 Agent 目录统一管理
  （见 [Agent](01-agent.md)「Agent 目录」），不再单设顶层 `rules.*` 配置。`agent.dir` 留空时默认 `~/.code-meeseeks/agent`；
  团队把 `agent.dir` 指向一个 git repo，所有人 clone 即同一套规则与上下文。规则纯「读」，跟可变状态隔离。
- **Markdown + YAML frontmatter，一文件一规则**：递归扫 `<agent.dir>/rules/` 下所有 `.md`（**目录层级不参与匹配**，纯组织，
  跳过隐藏目录）。frontmatter 是结构化元数据，**markdown 正文就是注入给 pr-agent 的 `extra_instructions`**——人能读、
  git diff 清楚、无重复内容。
  - **遍历性能兜底**：单目录递归收集 `.md` 封顶 `MAX_RULE_FILES`（200）个，到达即停并 warn——防止 `agent.dir` 被误指向
    超大目录树时一次加载扫穿海量文件。
- **匹配语义：每次 run 现读 + 取全部命中（封顶 N 条）**：
  1. 扫所有 `.md`，解析 frontmatter（解析失败 → warn + 跳过，不阻断）。
  2. 按 `priority desc + 文件路径 asc` 预排序。
  3. 对当前 `{ projectKey, repoSlug, targetBranch, tool }` 逐条 `.test()`：`enabled=false` / `tools` 不含当前工具 /
     `applies_to.<字段>` 正则不匹配 → 跳；字段缺省视为命中。
  4. **取全部命中**，封顶 `DEFAULT_MAX_MATCHED_RULES`（20）条（超出按排序丢弃靠后者，安全兜底防 prompt 膨胀）。
  5. 多条正文经 `combineRuleInstructions` 以 `## Ruleset N` 分段拼接（frontmatter 已在加载期被 gray-matter 剥离，
     不入正文），作 `extra_instructions`；分段标题让模型区分不同规约、互不串味。
  「全局基础 + 项目 override」仍可用 priority 数字表达（基础低、项目高 → 排在前、Ruleset 序靠前）。
- **per-tool 注入**：`/review` → `PR_REVIEWER__EXTRA_INSTRUCTIONS`、`/describe` → `PR_DESCRIPTION__EXTRA_INSTRUCTIONS`。
  Agentic 评审 / 规划走系统上下文的「Matched rules」段（同一拼接口径）。命中规则数在评审执行时经日志输出。
- **失败安全**：单文件 frontmatter 坏掉只跳过它，其余规则照常加载。

## 数据 / 接口契约

规则文件 frontmatter（字段均可省，省 = 匹配任意；值是**正则源串**）：

```markdown
---
applies_to:
  project: "^FX$"                  # projectKey 正则
  repo: "^fx-.*"                   # repoSlug 正则
  target_branch: "^(master|main)$" # PR base 分支名 正则
tools: [review]                    # 缺省 [review]
priority: 50                       # 缺省 0；越大越优先
enabled: true
---

# 正文即 extra_instructions（给 pr-agent 的规约）
```

配置：规则目录固定为 `<agent.dir>/rules/`（`agent.dir` 见 [配置与凭据](../99-core/02-config-and-secrets.md)，空 = 默认 `~/.code-meeseeks/agent`）。

## 扩展与注意事项

- **用户需懂正则**（学习成本）；UI 可后续给「按项目匹配」等 helper 自动 wrap 成 `^X$`。
- **多条命中全部生效**：命中的规则按 Ruleset 分段全部注入（封顶 20 条），UI 的「命中规则」chip 显示命中条数、
  预览弹窗按 Ruleset 逐条列出，便于确认本次 review 受哪些规约约束。
- frontmatter 未做严格 schema 校验，类型不对静默 fallback 默认值；规则多了可加严。
- 可扩展方向：按 `changed_paths` 匹配、规则 lint/预览、规则市场（导入导出 .md 包）、命中上限可配置。
