# 05 · 评审 → 发布闭环

## 职责与边界

从「跑一次评审」到「评论落到远端」的完整链路：命令执行 → 输出解析为结构化 findings → 草稿池 →
用户逐条确认/编辑/拒绝/手动追加 → 批量发布为 inline 评论；以及评论的 reply/edit/delete 与 PR 合并。

负责：评审命令编排、输出解析、草稿状态机、发布。不负责：跑 pr-agent 本身（见 [04](04-pragent-runtime.md)）、
平台评论 API（见 [01](01-platform-adapter.md)）。

## 核心设计

- **三个命令**：`/describe`（生成 PR 描述）、`/review`（生成评审 findings）、`/ask`（自由问答）。对话式
  交互 + **队列模型**：并发执行 ≤ `pr_agent.max_concurrency`（默认 2）条 run，其余 FIFO 排队；每个 run
  独立 worktree（路径带 nonce）+ 独立子进程，并发安全；支持中断/重试；run 状态与实时 stdout
  跨 PR 切换存活（模块级 store，不随组件卸载丢）。
- **输出解析为 findings**：pr-agent 把结果写进 worktree 的 markdown，解析层按 section 切分，把 `/review` 的
  「key_issues / Recommended focus areas」段展开成多条 `code-feedback` finding（每条 title + body + anchor）。
- **anchor（file:line 定位）双信号合并**：
  - 主源：嵌入式运行时补的 `get_line_link` 让 header 渲染成 `[**header**](meebox:///<file>#L<s>-L<e>)`，
    解析取其中**结构化 anchor**（path 来自 provider 同源，最可靠）。
  - 兜底：prompt 要求模型在正文附 `[file:…, lines:…]` marker；当链接只有 path、无行号时（模型没填结构化
    start/end）用 marker 的行号补全（仅同文件才借，避免错配）。
  - 取不到则 anchor 留空，UI 把「跳转编辑」按钮 disable。
- **草稿池（不直接发布）**：`/review` 成功后 code-feedback findings 自动入草稿池作候选；用户在 Diff 内联
  （DraftZone）编辑措辞 / 拒绝 / 手动追加；**显式确认后才批量 POST 远端**。再次 `/review` 会丢弃旧的 pending
  草稿、用新结果作候选（edited/posted/rejected/manual 保留）。
- **finding 状态机**：`pending → accepted/edited/rejected/posted`；发布成功落 `posted_remote_id` 作幂等 key，
  防重发。
- **发布走平台 inline 评论**：批量 `publishInlineComment`，内部 finding 锚点映射成平台锚点（见 [01](01-platform-adapter.md)）。
- **评论二次操作**：reply / edit / delete（带 can-edit/can-delete 预判：只允许操作自己作者的评论，远端再校验）；
  PR 合并按 `mergeStatus.canMerge` 控制入口，合并不可逆、远端二次校验。
- **token 用量落 run**：主进程逐行捕获子进程 stderr 的 `@@MEEBOX_USAGE@@` 哨兵累加（见 [04](04-pragent-runtime.md)），
  写入 `ReviewRun.tokenUsage`；UI run meta 展示 ↑输入 / ↓输出。
- **LLM 失败识别**：pr-agent 可能 exit 0 但 stdout 其实是 LLM 全失败（认证错 / 无可用模型）→ 解析层标 llmFailure，
  落 failed 而非「完成」。

## 数据 / 接口契约

- `Finding`：`title` / `body` / `anchor{path,startLine?,endLine?}` / `sectionKey` / 状态机字段
  （`severity` / `status` / `draft_body` / `posted_remote_id`）。
- `ReviewRun`：`tool` / `status` / `model` / `findings[]` / `tokenUsage{promptTokens,completionTokens,totalTokens,calls}` /
  `stdout`(LLM 产出 + 日志) / `summary` / 计时与错误字段。
- 评审 run 持久化于 per-PR 目录（见 [03](03-state-storage.md)）。

## 扩展与注意事项

- **`/improve` 不接**：pr-agent 社区版 + LocalGitProvider 下 `publish_code_suggestions` 不可用，故闭环改走
  「复用 `/review` 的 code-feedback finding 作 inline 候选」。
- **anchor 覆盖率**取决于模型是否填结构化行号 + 是否输出 marker；两路都用上以最大化覆盖。历史 run 无结构化
  `tokenUsage` 时 UI 回退到从 stdout 估算。
- **草稿语义**：再跑 `/review` 只清 pending，避免误删用户已编辑/已发布的草稿。
- 发布是有副作用的远端写，务必走幂等（posted_remote_id）。
