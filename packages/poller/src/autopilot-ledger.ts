import type { AutopilotLedger, AutopilotLedgerFile } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * The AutoPilot ledger lives at `prs/<localId>/agent/autopilot.json`, alongside session / transcript in that
 * PR directory; on PR retirement deleteDir wipes it too (see docs/arch/02-agent/03-autopilot.md "AutoPilot").
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
 * Wipe this PR's AutoPilot ledger (deleted together when clearing execution history). The ledger holds the review verdict, on which the PR list ★ badge
 * is displayed; once deleted the ★ disappears, avoiding a stale review status lingering after clearing results.
 */
export async function clearAutopilotLedger(
  stateStore: StateStore,
  prLocalId: string,
): Promise<void> {
  await stateStore.delete(ledgerKey(prLocalId));
}

/**
 * Whether this PR needs an auto review: true if there is no ledger (never run) or the ledger's recorded updatedAt does not match the current one
 * (the PR has changed). Returns false if the content is unchanged (dedup, no repeat run).
 */
export async function needsAutoReview(
  stateStore: StateStore,
  prLocalId: string,
  currentUpdatedAt: string,
): Promise<boolean> {
  const ledger = await getAutopilotLedger(stateStore, prLocalId);
  return !ledger || ledger.autoReviewedUpdatedAt !== currentUpdatedAt;
}
