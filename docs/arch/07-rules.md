# 07 · 规则系统

## 职责与边界

让评审带上团队/仓库的编码规约：存储用户写的规则、按 PR 上下文匹配、把命中规则注入 pr-agent 的
`extra_instructions`。

负责：规则加载/匹配/注入。不负责：pr-agent 调用（见 [04](04-pragent-runtime.md)）、规则正文怎么写（用户的事）。

## 核心设计

- **独立目录 `rules.dir`，与应用数据解耦**：配置在 `config.yaml`（`rules.dir` + `rules.enabled`），**不放**
  `~/.code-meeseeks/` 下。理由：团队把 `rules.dir` 指向一个 git repo，所有人 clone 即同一套规则；个人默认空 =
  不启用、pr-agent 走原生行为；规则纯「读」，跟可变状态隔离。
- **Markdown + YAML frontmatter，一文件一规则**：递归扫 `rules.dir` 下所有 `.md`（**目录层级不参与匹配**，纯组织）。
  frontmatter 是结构化元数据，**markdown 正文就是注入给 pr-agent 的 `extra_instructions`**——人能读、git diff 清楚、
  无重复内容。
- **匹配语义：每次 run 现读 + 取首条命中**：
  1. 扫所有 `.md`，解析 frontmatter（解析失败 → warn + 跳过，不阻断）。
  2. 按 `priority desc + 文件路径 asc` 预排序。
  3. 对当前 `{ projectKey, repoSlug, targetBranch, tool }` 逐条 `.test()`：`enabled=false` / `tools` 不含当前工具 /
     `applies_to.<字段>` 正则不匹配 → 跳；字段缺省视为命中。
  4. **取第一条**命中，正文作 `extra_instructions`。
  不拼接多条：避免 prompt 膨胀、规则冲突优先级不可控。「全局基础 + 项目 override」用 priority 数字表达
  （基础低、项目高 → 高优先级胜出）。
- **per-tool 注入**：`/review` → `PR_REVIEWER__EXTRA_INSTRUCTIONS`、`/describe` → `PR_DESCRIPTION__EXTRA_INSTRUCTIONS`。
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

配置：`rules.dir`（路径，空 = 停用）/ `rules.enabled`（总开关）。

## 扩展与注意事项

- **用户需懂正则**（学习成本）；UI 可后续给「按项目匹配」等 helper 自动 wrap 成 `^X$`。
- **「取首条」易困惑**（写了多条怎么只生效一条）—— 靠文档 + 在 UI 显式展示「当前命中规则」消除疑惑。
- frontmatter 未做严格 schema 校验，类型不对静默 fallback 默认值；规则多了可加严。
- 可扩展方向：多规则拼接模式（`merge_strategy`）、按 `changed_paths` 匹配、规则 lint/预览、规则市场（导入导出 .md 包）。
