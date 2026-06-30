import { invoke } from '../../../../api';
import type { CommandContext, RootCommand } from './types';
import { formatChord } from './shortcuts';

function toggleAutopilot(ctx: CommandContext): void {
  const enabled = !ctx.config.agent.autopilot.enabled;
  void invoke('agent:setAutopilotEnabled', { enabled });
  ctx.patchConfig((c) => ({
    ...c,
    agent: { ...c.agent, autopilot: { ...c.agent.autopilot, enabled } },
  }));
}

/**
 * 「评审」领域命令：开关 AutoPilot、对当前 PR 运行自动评审。运行自动评审走与 ChatPane「一键自动评审」
 * 同一通道（`agent:run`），运行态与会话经事件 / store 反映；需当前选中 PR 且 LLM 已配置才列出
 * （无 `when` 机制前先按上下文裁剪）。
 */
export function buildReviewCommands(ctx: CommandContext): RootCommand[] {
  const { t, tEn, selectedPrId, isPrRunning } = ctx;
  const category = t('commandPalette.categoryReview');
  const categoryEn = tEn('commandPalette.categoryReview');
  const cmd = (key: string): Pick<RootCommand, 'title' | 'titleEn' | 'category' | 'categoryEn'> => ({
    category,
    categoryEn,
    title: t(key),
    titleEn: tEn(key),
  });
  // 域内按英文名字典序：Run Auto Review < Toggle AutoPilot < Toggle Chat Panel
  return [
    {
      id: 'run-auto-review',
      ...cmd('commandPalette.cmdRunAutoReview'),
      // 门控：有选中 PR 才出现（无 PR 无意义）。执行时再做重入保护：同一 PR 已在跑则忽略。走与 ChatPane
      // 一键评审同通道，运行态 / 会话经事件 + store 反映；LLM 未配置 / pr-agent 未就绪由后端按失败回流到会话。
      when: () => Boolean(selectedPrId),
      shortcut: ['F5'], // 运行（IDE 惯例）；单键避开组合冲突，见 App 窗口级快捷键
      run: () => {
        if (selectedPrId && !isPrRunning(selectedPrId)) {
          void invoke('agent:run', { localId: selectedPrId });
        }
      },
    },
    {
      id: 'toggle-autopilot',
      ...cmd('commandPalette.cmdToggleAutopilot'),
      run: () => toggleAutopilot(ctx),
    },
    {
      id: 'toggle-chat-panel',
      ...cmd('commandPalette.cmdToggleChatPanel'),
      shortcut: formatChord(ctx.platform, 'J'),
      run: () => ctx.toggleChatPanel(),
    },
  ];
}
