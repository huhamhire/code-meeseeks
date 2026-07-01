import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PrAgentStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import {
  AutoReviewIcon,
  CommitIcon,
  EyeOffIcon,
  FileTreeIcon,
  SendIcon,
  StopIcon,
} from '../../../common';
import { useChatInput } from '../hooks/useChatInput';
import { useTextareaAutosizeDrag } from '../hooks/useTextareaAutosizeDrag';

interface ChatInputBarProps {
  pr: StoredPullRequest | null;
  prAgent: PrAgentStatus;
  /** LLM 是否已配置；未配置时禁用输入（即便 pr-agent 运行时就绪也无法调用） */
  llmConfigured: boolean;
  /**
   * 本 PR 上的活动 run 工具；非空时在 send 按钮旁额外渲染 stop 按钮。
   * 队列模型下输入永不因此禁用 (新提交进队列)。
   */
  runningTool: ReviewRunTool | null;
  onRun: (tool: ReviewRunTool, question?: string) => void;
  /** 无 '/' 前缀的自然语言输入 → 交给自由规划 Agent（对话即委派，见设计「会话 Agent 化」）。 */
  onAgentAsk: (question: string) => void;
  /**
   * 终止当前活动 run。仅 runningTool 非空时有意义；ChatPane 已绑好对应 runId。
   * stop 按钮跟 send 共用槽位：runningTool 时点击触发此回调而非 onRun
   */
  onCancel?: () => void;
  /** /approve /needswork 命令触发的 review 决断，跟 PR header 按钮共用 prs:setLocalStatus */
  onSetReviewStatus?: (status: LocalPrStatus) => void;
  /** PR 远端可直接合并（mergeStatus.canMerge）：决定 /merge 是否在命令菜单 / 补全出现。 */
  canMerge: boolean;
  /** /merge 命令触发（弹二次确认后实际合并，跟 PR header 合并按钮共用 prs:merge）。 */
  onMerge?: () => void;
  /** Agent 是否跑在当前 PR：决定图标按钮高亮 + 运行中文案 + 禁用重复发起（其它 PR 在跑不禁用本 PR）。 */
  agentRunningHere: boolean;
  /** 触发一键自动评审微流程（describe→review→条件追问→总结）。 */
  onAgentReview: () => void;
  /**
   * 当前 Diff 选区行数；null = 无选区（不渲染选区角标）。角标位于 AutoReview 右侧，提示「N 行已选中」，
   * 发送时把选中代码作为隐式上下文带进提问。
   */
  selectionLineCount: number | null;
  /** 选区忽略态：true 时本条消息不带选区引用（角标置灰 + eye-slash）。 */
  selectionIgnored: boolean;
  /** 点击选区角标 → 切换忽略态。 */
  onToggleSelection: () => void;
  /** 复评引用 chip：引用了某条 finding 时展示「复评 <file:line>」+ 清除；null = 不渲染。 */
  referenceChip?: { label: string; onClear: () => void } | null;
  /**
   * 单 commit 范围 chip：跟随 Diff 视图选中的 commit 展示「短 SHA · 主题」。存在选中即显示，点击**切换启用/禁用**
   * （禁用不删除 chip，本会话命令回到 PR 全量；禁用态置灰 + eye-slash）——选中态源自视图，可手动禁用。
   */
  commitScopeChip?: { label: string; disabled: boolean; onToggle: () => void } | null;
}

/**
 * 输入栏：textarea + 命令按钮 + `/` 触发的自动补全。状态机（输入 / 命令解析 / 补全 / 历史回放 /
 * 停止）见 [useChatInput](../hooks/useChatInput.ts)；命令解析纯逻辑见 ../utils/parse-command。
 *
 * 提交语义：空不提交；`/describe` `/review` 等触发对应工具；`/ask <文本>` 触发 ask；未知 `/xxx` 报错；
 * 不以 `/` 开头 = 自然语言委派给自由规划 Agent。Shift+Enter 换行，Enter 提交。
 */
export function ChatInputBar({
  pr,
  prAgent,
  llmConfigured,
  runningTool,
  onRun,
  onAgentAsk,
  onCancel,
  onSetReviewStatus,
  canMerge,
  onMerge,
  agentRunningHere,
  onAgentReview,
  selectionLineCount,
  selectionIgnored,
  onToggleSelection,
  referenceChip,
  commitScopeChip,
}: ChatInputBarProps) {
  const { t } = useTranslation();
  const {
    input,
    setInput,
    parseError,
    disabled,
    running,
    stopRequested,
    requestStop,
    showAutocomplete,
    filtered,
    visibleCommands,
    autocompleteIdx,
    setAutocompleteIdx,
    cmdMenuOpen,
    setCmdMenuOpen,
    handleInsertCommand,
    onKeyDown,
    submit,
    placeholder,
    textareaRef,
    cmdMenuRef,
  } = useChatInput({
    pr,
    prAgent,
    llmConfigured,
    runningTool,
    agentRunningHere,
    onRun,
    onAgentAsk,
    onCancel,
    onSetReviewStatus,
    canMerge,
    onMerge,
  });
  const { textareaHeightPx, handleTextareaResizeStart } = useTextareaAutosizeDrag(textareaRef);

  return (
    <form
      className="chat-pane-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {showAutocomplete && filtered.length > 0 && (
        <ul className="chat-cmd-suggest" role="listbox" aria-label={t('chatPane.cmdSuggestAria')}>
          {filtered.map((c, i) => {
            const active = i === Math.min(autocompleteIdx, filtered.length - 1);
            const prev = filtered[i - 1];
            const needDivider = prev !== undefined && prev.kind !== c.kind;
            return (
              <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
                <button
                  type="button"
                  className={`chat-cmd-suggest-item${active ? ' active' : ''}`}
                  onClick={() => handleInsertCommand(c)}
                  onMouseEnter={() => setAutocompleteIdx(i)}
                  onMouseDown={(e) => {
                    // 防止 textarea 失焦后 blur 处理把菜单收掉
                    e.preventDefault();
                  }}
                  role="option"
                  aria-selected={active}
                >
                  <code>{c.label}</code>
                  <span className="muted">{t(c.descKey)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="chat-pane-textarea-wrap">
        {/* 顶边拖动 handle：向上拖 → textarea 高度增加，跟视觉扩展方向一致 */}
        <div
          className="chat-pane-textarea-resize-handle"
          onMouseDown={handleTextareaResizeStart}
          title={t('chatPane.resizeInputTitle')}
          aria-label={t('chatPane.resizeInputAria')}
        />
        <textarea
          ref={textareaRef}
          className="chat-pane-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          aria-label={t('chatPane.inputAria')}
          style={
            textareaHeightPx !== null ? { height: `${String(textareaHeightPx)}px` } : undefined
          }
        />
      </div>
      {parseError && <div className="chat-input-error">{parseError}</div>}
      <div className="chat-pane-input-row">
        <div className="chat-cmd-group">
          <div className="chat-cmd-bar" ref={cmdMenuRef}>
            <button
              type="button"
              className={`chat-cmd-trigger${cmdMenuOpen ? ' active' : ''}`}
              onClick={() => setCmdMenuOpen((v) => !v)}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={cmdMenuOpen}
              title={t('chatPane.cmdTriggerTitle')}
            >
              /
            </button>
            {cmdMenuOpen && (
              <ul className="chat-cmd-menu" role="menu">
                {visibleCommands.map((c, i) => {
                  const prev = visibleCommands[i - 1];
                  // pragent → review-action 边界插一道分隔线
                  const needDivider = prev !== undefined && prev.kind !== c.kind;
                  return (
                    <li key={c.name} className={needDivider ? 'chat-cmd-menu-group' : undefined}>
                      <button
                        type="button"
                        className="chat-cmd-suggest-item"
                        onClick={() => handleInsertCommand(c)}
                        role="menuitem"
                      >
                        <code>{c.label}</code>
                        <span className="muted">{t(c.descKey)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {/* 自动评审：图标按钮紧贴 `/` 命令触发器右侧。仅 pr-agent 就绪时出现，LLM 未配置 / 本 PR 评审
            进行中则禁用触发（其它 PR 在跑不禁用——可并发 / 排队）。停止统一由发送区的停止按钮负责（取消
            进行中的子任务即终止流程），不再单独提供 Agent 停止按钮，避免两个语义重叠的停止入口。 */}
          {pr && prAgent.available && (
            <button
              type="button"
              className={`chat-cmd-trigger chat-agent-review-trigger${agentRunningHere ? ' active' : ''}`}
              onClick={onAgentReview}
              disabled={!llmConfigured || agentRunningHere}
              title={
                agentRunningHere
                  ? t('chatPane.agent.autoReviewRunning')
                  : t('chatPane.agent.autoReview')
              }
              aria-label={t('chatPane.agent.autoReview')}
            >
              <AutoReviewIcon />
            </button>
          )}
          {/* Diff 选区角标：竖线分隔后展示「N 行已选中」。点击切忽略态（eye-slash + 置灰）——忽略时
              本条消息不带选区引用。选中代码以隐式上下文随提问发出，不进入会话气泡。 */}
          {selectionLineCount !== null && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <button
                type="button"
                className={`chat-selection-chip${selectionIgnored ? ' ignored' : ''}`}
                onClick={onToggleSelection}
                title={
                  selectionIgnored
                    ? t('chatPane.selection.ignoredTitle')
                    : t('chatPane.selection.attachedTitle')
                }
              >
                {selectionIgnored ? <EyeOffIcon /> : <FileTreeIcon />}
                <span>{t('chatPane.selection.linesSelected', { lines: selectionLineCount })}</span>
              </button>
            </>
          )}
          {/* 复评引用 chip：引用了某条 review/improve finding 时展示「复评 <file:line>」，点 ✕ 清除引用。
              发送时本条 /ask 会携带该 finding 引用走复评模式（出裁决 + 采纳/关闭动作）。 */}
          {referenceChip && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <span className="chat-selection-chip chat-reference-chip" title={referenceChip.label}>
                <FileTreeIcon />
                <span>{referenceChip.label}</span>
                <button
                  type="button"
                  className="chat-reference-chip-clear"
                  onClick={referenceChip.onClear}
                  title={t('chatPane.reference.clearTitle')}
                  aria-label={t('chatPane.reference.clearTitle')}
                >
                  ✕
                </button>
              </span>
            </>
          )}
          {/* 单 commit 范围 chip：跟随视图选中的 commit 展示「短 SHA · 主题」。点击切换启用/禁用（不删除）——
              启用时命令限定在该 commit（parent..sha），禁用则回到 PR 全量、置灰 + eye-slash。 */}
          {commitScopeChip && (
            <>
              <span className="chat-cmd-divider" aria-hidden="true" />
              <button
                type="button"
                className={`chat-selection-chip chat-reference-chip${commitScopeChip.disabled ? ' ignored' : ''}`}
                onClick={commitScopeChip.onToggle}
                title={
                  commitScopeChip.disabled
                    ? t('chatPane.scopeDisabledTitle')
                    : t('chatPane.scopeActiveTitle')
                }
              >
                {commitScopeChip.disabled ? <EyeOffIcon /> : <CommitIcon size={14} />}
                <span>{commitScopeChip.label}</span>
              </button>
            </>
          )}
        </div>
        {/* 队列模型下 send 永远在 (新提交进队列)；本 PR active 时 stop 紧贴 send 左侧。
            包到一个 group 里避免 input-row 的 space-between 把 stop 推到中央 */}
        <div className="chat-pane-send-group">
          {running && onCancel && (
            <button
              type="button"
              className="chat-pane-send chat-pane-send-stop"
              onClick={requestStop}
              disabled={stopRequested}
              title={t('chatPane.stopTitle')}
              aria-label={t('chatPane.stopAria')}
            >
              <StopIcon />
            </button>
          )}
          <button
            type="submit"
            className="chat-pane-send"
            disabled={disabled || !input.trim()}
            title={running ? t('chatPane.sendQueuedTitle') : t('chatPane.sendTitle')}
            aria-label={t('chatPane.sendAria')}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </form>
  );
}
