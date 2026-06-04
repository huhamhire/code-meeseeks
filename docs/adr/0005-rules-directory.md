# ADR-0005: 个性化规则目录 rules.dir

- **状态**：Accepted
- **日期**：2026-06-02
- **决策者**：项目主导
- **相关**：[ROADMAP §M3](../ROADMAP.md#m3--pr-agent-集成-2-周核心)、[ADR-0001 pr-agent 集成](0001-pr-agent-integration.md)
- **实现包**：[`@meebox/rules`](../../packages/rules/)

## 背景

pr-agent 默认 prompt 是通用的，缺乏对**具体团队 / 仓库**编码规约的感知（命名约定、必须有单元测试、特定库用法、安全清单等）。pr-agent 支持 `--extra_instructions`（per-tool 配置 / env，例如 `PR_REVIEWER__EXTRA_INSTRUCTIONS`）把自定义提示拼到 system prompt 上，但需要 meebox 来：

1. **存储**用户写的规则
2. **匹配** PR 上下文（按项目 / 仓库 / 分支）
3. **注入** pr-agent 容器

需求边界（用户对齐确认）：

- 规则要能**用 git 版本控制**、跟团队共享 —— 不能挤在 `~/.code-meeseeks/` 个人配置里
- 用 **markdown** 文档管理 —— 人读 / git diff / IDE 编辑都自然，避免 yaml-only 文件那种"全是 metadata 没正文"的感觉
- 支持按**项目维度**匹配，最小集还要支持仓库 / base 分支
- 同一 PR 多条规则命中时**只取第一条**，避免 prompt 膨胀和规则互相矛盾

## 决策

### 1. 独立配置 `rules.dir`，跟应用数据目录解耦

`config.yaml` 顶层加：

```yaml
rules:
  dir: ~/code/team-pr-rules    # 可空；任意路径，建议指向一个 git repo
  enabled: true                # 总开关，dir 配了但想临时停用时用
```

`rules.dir` **不放在 `~/.code-meeseeks/` 下**。理由：

- 团队场景：用户把 `rules.dir` 指到 `~/code/team-pr-rules` 这种用 git 维护的仓库，所有人 clone 它就能拿同一套规则
- 个人场景：默认 `dir` 为空 = 不启用，pr-agent 走 vanilla 行为
- 跟其他可变数据（state / logs）隔离，规则目录纯粹是"读"，不会被应用写脏

### 2. Markdown + YAML frontmatter，一个文件 = 一条规则

文件结构（递归扫描所有 `.md`，**目录层级不参与匹配**，纯组织作用）：

```
<rules.dir>/
├── README.md                       # frontmatter 标 enabled:false 排除自身
├── global/
│   └── coding-style.md
├── projects/
│   └── FX/
│       ├── common.md
│       └── fx-help/
│           └── api-guidelines.md
└── archived/
    └── legacy-rule.md              # frontmatter enabled:false 临时停用
```

单条规则文件格式：

```markdown
---
# 适用范围：各字段可省，省 = 匹配任意；值是**正则源串**
applies_to:
  project: "^FX$"              # Bitbucket Server projectKey 正则
  repo: "^fx-.*"               # Bitbucket Server repoSlug 正则
  target_branch: "^(master|main)$"  # PR base 分支显示名
# 哪些 pr-agent 工具生效，缺省 [review]。规则语义是代码评审规约，给 /describe
# (PR 描述生成) 注入约束会让描述偏题；想同时影响 /describe 写 [describe, review]
tools: [review]
# 命中后建议给 pr-agent 加的 labels (P0 暂只解析存储，pr-agent env 集成留 P1)
custom_labels: [tech-debt, needs-tests]
# 同时命中多条时按 priority desc 排序，取首个；默认 0
priority: 50
# 关闭规则但保留文件
enabled: true
---

# FX 项目代码规约

任何 `Array.reduce` 调用必须有注释说明聚合逻辑。

数据库查询必须带 limit 子句，禁止无界查询。

API 接口入参必须有 zod schema 校验。
```

**frontmatter** 是结构化元数据，**markdown 正文**就是给 pr-agent 看的 `extra_instructions`。这样一份文件人能读、git diff 清楚、pr-agent 直接吃 markdown，无重复内容。

### 3. 匹配语义：每次 run 现读 + 取首条命中

每次 `pragent:run`：

1. 递归扫 `rules.dir` 下所有 `.md`
2. `gray-matter` 解析 frontmatter（解析失败的文件 → warn 日志 + 跳过，不阻断）
3. 内存里按 `priority desc + 文件路径 asc` 预排序
4. 对当前 PR 上下文 `{ projectKey, repoSlug, targetBranch, tool }` 逐条 `.test()`：
   - `enabled === false` → 跳
   - `tools` 不含当前 `tool` → 跳
   - `applies_to.<field>` 存在但正则 `.test()` false → 跳；字段缺省视为命中
5. **取第一条**命中的规则，正文作 `extra_instructions` 注入 env

不拼接多规则 / 不并集 labels 的理由：

- prompt 膨胀风险（LLM 上下文 + cost）
- 多条规则冲突时优先级不可预测；强制单条让"最具体的规则胜出"可控
- 用户想要"全局基础规约 + 项目特定 override"的语义，用 priority 数字表达：基础规约 priority 0，项目规约 priority 100 → 高优先级胜出

### 4. 注入到 pr-agent 的 env

per-tool 不同 env 变量：

| 触发工具 | env 变量 |
|---|---|
| `/describe` | `PR_DESCRIPTION__EXTRA_INSTRUCTIONS` |
| `/review` | `PR_REVIEWER__EXTRA_INSTRUCTIONS` |

`custom_labels` 的 env 名 P0 阶段先 TBD，P1 时确认 pr-agent 0.35 的具体配置项。

### 5. UI 拆 P0 / P1 两刷交付

- **P0（已完成）**：rules loader + matcher + ipc 注入 env；Settings 上**不**做规则编辑入口（用户用 IDE 写 markdown）
- **P1（待做）**：Settings 加 `rules.dir` 文本输入 + 浏览按钮（复用 `dialog:pickDirectory` IPC）；StatusBar chip 显示当前 PR 命中的规则名，点击弹出规则正文预览

## 后果

### 优点

- **团队共享自然成立**：rules.dir 指 git repo，team 通过 PR 协作维护规则
- **跟 pr-agent 解耦**：本地匹配 + 注入 env，不依赖 pr-agent 升级带来的 schema 变化
- **正则灵活**：单字段正则覆盖了 90% 场景，比 glob 表达力强（"非某仓库"用 `^(?!fx-internal)` 也成立）
- **失败安全**：单个文件 frontmatter 烂掉 → 跳过 + warn，其他规则继续加载

### 缺点 / 限制

- 用户必须懂正则（学习成本）。考虑后续在 UI 给常用模式的 helper（"添加按项目匹配"自动 wrap 成 `^X$`）
- "取首条"语义可能让用户困惑（明明写了多条规则怎么没全部生效）。需要文档 + P1 阶段在 StatusBar 显式展示"当前命中规则"消除疑惑
- frontmatter 没做 zod / json-schema 严格校验，类型不对的字段静默 fallback 到默认值。规则多了之后可以考虑加严

### 后续可扩展

- **多规则拼接模式**：未来如果需求出现，加一个 `merge_strategy: 'first' | 'concat'` 顶层 config，保持向后兼容
- **基于 changed_paths 匹配**：`applies_to.changed_paths: "src/api/.*\.ts"`，把规则按文件粒度精准化
- **规则 lint / 预览**：CLI 工具 `meebox rules check` 离线 dry-run 一个 PR 看哪条规则命中
- **规则市场**（[ROADMAP M5](../ROADMAP.md#m5--打磨与多平台扩展持续)）：导入 / 导出 .md 包，社区共享行业实践

## 实现状态

- ✅ P0：[`packages/rules/`](../../packages/rules/) 包；loader + matcher + 24 条单测
- ✅ P0：[`apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) `pragent:run` handler 集成
- ✅ P0：[`packages/shared/src/config.ts`](../../packages/shared/src/config.ts) Schema
- ⏭️ P1：Settings UI 入口 + StatusBar 命中规则展示
