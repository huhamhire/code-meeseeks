import type { AutopilotLedger, AutopilotLedgerFile } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * AutoPilot 台账落 `prs/<localId>/agent/autopilot.json`，与 session / transcript 同处该
 * PR 目录，PR 退场时 deleteDir 一并清掉（见 docs/arch/06-agent.md「AutoPilot」）。
 */
function ledgerKey(prLocalId: string): string {
  return `prs/${prLocalId}/agent/autopilot`;
}

export async function getAutopilotLedger(
  stateStore: StateStore,
  prLocalId: string,
): Promise<AutopilotLedger | null> {
  const file = await stateStore.read<AutopilotLedgerFile>(ledgerKey(prLocalId));
  return file?.ledger ?? null;
}

export async function writeAutopilotLedger(
  stateStore: StateStore,
  ledger: AutopilotLedger,
): Promise<void> {
  await stateStore.write<AutopilotLedgerFile>(ledgerKey(ledger.prLocalId), {
    schema_version: 1,
    ledger,
  });
}

/**
 * 该 PR 是否需要自动评审：无台账（从未跑过）或台账记录的 updatedAt 与当前不一致
 * （PR 已变更）即为 true。内容未变则 false（去重，不重复跑）。
 */
export async function needsAutoReview(
  stateStore: StateStore,
  prLocalId: string,
  currentUpdatedAt: string,
): Promise<boolean> {
  const ledger = await getAutopilotLedger(stateStore, prLocalId);
  return !ledger || ledger.autoReviewedUpdatedAt !== currentUpdatedAt;
}
