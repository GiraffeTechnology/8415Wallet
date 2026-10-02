import type { OperationState } from '../controls/operationJournal.ts';
export function recoveryGuidance(state: OperationState | null): string {
  if (state === null) return 'Connect the same wallet account, chain and deployment to inspect its saved operation. No automatic resend.';
  if (state.status === 'idle') return 'No unresolved operation in this account journal. Each new transaction still needs your wallet confirmation.';
  if (state.status === 'submitted') return 'A transaction hash is saved. Reconcile its canonical receipt and expected effects. A hash alone is not success. Acknowledge only a freshly verified terminal receipt.';
  if (state.submission === null) return 'An interrupted intent has no prepared send template. You may explicitly discard this unprepared intent. No wallet send was prepared by this session.';
  return 'Outcome unknown: a send template was saved before the wallet prompt, but no confirmed response was saved. Do not send again or clear browser storage. Check this account in your wallet activity. If a hash exists, verify it against the saved intent; otherwise keep the journal and resolve the original wallet prompt. A different transaction can clear this only after proof that it canonically consumed the exact saved nonce. An unchanged nonce or a missing hash does not prove cancellation.';
}
