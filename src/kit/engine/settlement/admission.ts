import { reject } from '../projection/errors.ts';
import { validateCandidateShape } from '../projection/kernel.ts';
import type { CandidateEntry, Instant, Settlement } from '../projection/types.ts';

/** Shared by trusted settlement callers and the authenticated HTTP admission route. */
export const assertSettlementAdmission = (record: Settlement, candidate: CandidateEntry, now: Instant): void => {
  if (record.status !== 'OPEN') {
    reject('NO_OPEN_GAP', `settlement ${record.settlementId} is not open`);
  }
  if (now > record.deadline) {
    reject('SETTLEMENT_EXPIRED', `settlement ${record.settlementId} ran past its deadline`);
  }
  validateCandidateShape(candidate);
  if (candidate.holder.toLowerCase() !== record.expectedHolder.toLowerCase()) {
    reject('HOLDER_MISMATCH', 'the admitted holder is not the one this settlement was opened for');
  }
};
