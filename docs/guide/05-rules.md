# 自定义评审规则

评审规则让你把团队规约、风格偏好、关注点注入 AI 评审：命中的规则正文会作为 `extra_instructions` 传给 pr-agent，影响 `/review`（及可选的 `/describe`）的产出。

规则是**纯文件**：一个规则目录下，每个 `.md` 文件就是一条规则。`frontmatter`（文件顶部的 YAML）声明这条规则**何时命中**，正文（markdown）是命中后**注入给 AI 的指令**。

## 启用规则目录

在 `config.yaml` 配置规则目录（见 [配置文件参考 · rules](04-config-reference.md#rules--个性化规则)）：

```yaml
rules:
  dir: ~/code-review-rules   # 规则目录；留空 = 不启用
  enabled: true              # 全局开关
```

建议把规则目录指向一个 git 仓库，便于团队共享与版本化。目录下可按子目录组织，应用会递归扫描所有 `.md`。

## 规则文件结构

```markdown
---
applies_to:
  project: '^FX$'
  repo: '^fx-.*'
  target_branch: '^(main|release/.*)$'
tools: [review]
priority: 10
enabled: true
---

- 公共方法必须有 JSDoc，说明参数与返回值。
- 金额一律用整数分存储，禁止浮点。
- 对外接口变更需在 PR 描述里标注「Breaking」。
```

- `---` 之间是 **frontmatter（YAML）**，声明命中条件；可整段省略。
- `---` 之后是**正文（markdown）**，作为命中后注入 AI 的指令，用清晰的祈使句逐条写效果最好。

### frontmatter 字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `applies_to.project` | 正则源串 | 省略 = 匹配任意 | 命中项目标识：Bitbucket 为 project key，GitHub 为组织 / 用户名。 |
| `applies_to.repo` | 正则源串 | 省略 = 匹配任意 | 命中仓库 slug。 |
| `applies_to.target_branch` | 正则源串 | 省略 = 匹配任意 | 命中 PR 的**目标分支**名。 |
| `tools` | 数组 | `[review]` | 规则作用的工具，可取 `review` / `describe`。默认只作用于 `/review`（评审规约注入 `/describe` 会让描述偏题）。 |
| `priority` | 数字 | `0` | 多条规则同时命中时的取舍权重，越大越优先（见下「命中与取舍」）。 |
| `enabled` | 布尔 | `true` | 单条规则开关；`false` 时跳过该文件（区别于全局 `rules.enabled`）。 |
| `custom_labels` | 数组 | `[]` | 预留字段，当前版本解析但尚未注入 pr-agent。 |

> **正则说明**：`applies_to.*` 的值是正则**源串**，**不自动加锚点** `^`/`$`，是否精确匹配由你自己写。例如 `fx` 会匹配任何含 `fx` 的名字；要精确匹配写 `^fx$`。非法正则会被忽略（视为该字段未配置）。

## 命中与取舍

对某个 PR 执行某个工具时，规则按以下逻辑筛选：

1. **工具过滤**：规则的 `tools` 不含当前工具 → 不命中。
2. **范围匹配**：`applies_to` 的每个字段——省略即匹配任意；配置了则该字段值需通过其正则 `.test()`。三项是 **AND** 关系（都要满足）。

> **只有一条规则生效**：同一 PR + 工具可能命中多条规则，应用只取**其中一条**——按 `priority` 降序、再按文件路径升序，取**第一条**。需要更细的规则覆盖更泛的规则时，把它的 `priority` 调高。

## 全局基础规约

不写 frontmatter（或留空）的规则文件 = **匹配任意 PR** 的基础规约（`tools` 默认 `[review]`）。适合放一份团队通用约定：

```markdown
评审时请重点关注：
- 错误处理是否完整，是否吞掉异常。
- 是否有重复代码可抽取复用。
- 命名是否清晰、与周边代码风格一致。
```

## 示例

**按目标分支收紧**：只对合并到 `release/*` 的 PR 强化检查。

```markdown
---
applies_to:
  target_branch: '^release/.*'
tools: [review]
priority: 20
---

- 这是发布分支，禁止引入新依赖。
- 任何行为变更必须有对应测试覆盖。
```

**按仓库定制**：只对某仓库生效。

```markdown
---
applies_to:
  repo: '^payment-service$'
---

- 涉及金额计算的改动需双人复核，评审中标注风险点。
```

## 注意事项

- **改动即生效**：规则文件增删改后，下次触发评审即按最新内容加载，无需重启。
- **单文件解析失败不影响整体**：某个文件 frontmatter YAML 写坏 / 字段类型不对，应用会跳过该文件并继续加载其余规则。
- **当前命中提示**：选中 PR 后，chat 面板会显示本次命中的规则标识，点击可预览规则正文，便于确认本次评审受哪条规则约束。

> 设计与实现细节见架构文档 [docs/arch/07-rules.md](../arch/07-rules.md)。
