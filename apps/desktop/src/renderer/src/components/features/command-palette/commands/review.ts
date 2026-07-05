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
 * "Review" domain commands: toggle AutoPilot, run auto review on the current PR. Running auto review goes through the same channel
 * (`agent:run`) as ChatPane's "one-click auto review"; run state and session are reflected via events / store; listed only when a PR is selected and the LLM is configured
 * (trimmed by context until a `when` mechanism exists).
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
  // Within-domain English-name lexicographic order: Run Auto Review < Toggle AutoPilot < Toggle Chat Panel
  return [
    {
      id: 'run-auto-review',
      ...cmd('commandPalette.cmdRunAutoReview'),
      // Gating: only appears when a PR is selected (meaningless without one). Reentrancy guard at execution: ignore if the same PR is already running. Uses the same channel as ChatPane's
      // one-click review; run state / session reflected via events + store; LLM not configured / pr-agent not ready flow back into the session as a failure from the backend.
      when: () => Boolean(selectedPrId),
      shortcut: ['F5'], // Run (IDE convention); single key avoids combo conflicts, see App window-level shortcuts
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
