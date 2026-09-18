import { assertSettlementAdmission } from './admission.ts';
import { reject } from '../projection/errors.ts';
import type { ProjectionStore, AdmissionResult } from '../projection/store.ts';
import type { ProofMaterial } from '../proof/profile.ts';
import type { SettlementAuthority } from './authority.ts';
import type { Clock } from '../ports.ts';
import {
  ZERO_BYTES32,
  isAddress,
  isBytes32,
  isUint64,
  type Address,
  type Bytes32,
  type CandidateEntry,
  type Instant,
  type Settlement,
  type TokenId,
} from '../projection/types.ts';

export interface SettlementEngineOptions {
  readonly store: ProjectionStore;
  readonly authority: SettlementAuthority;
  readonly clock: Clock;
  /** The maximum an open gap may run for, as `settlementPeriod()` reports. */
  readonly settlementPeriod: Instant;
}

export interface BeginRequest {
  readonly tokenId: TokenId;
  readonly settlementId: Bytes32;
  readonly initiator: Address;
  readonly expectedHolder: Address;
  readonly snapshotHash: Bytes32;
  readonly deadline: Instant;
}

/**
 * The settlement workflow over the projection's gap records.
 *
 * Three things this engine deliberately cannot do, because the standard says
 * so and an application that wants otherwise must build it itself:
 *
 * - it cannot block a transfer. There is no transfer here to block, and an
 *   open gap is a record beside the projection, never a lock on it;
 * - it cannot finalise anything. Opening, cancelling, expiring and closing a
 *   gap all leave `isFinalAsOf` exactly where it was;
 * - it cannot reject an entry. There is no rejection path: an admission that
 *   does not verify never becomes an entry, and one that does is permanent.
 */
export class SettlementEngine {
  readonly #options: SettlementEngineOptions;

  constructor(options: SettlementEngineOptions) {
    this.#options = options;
  }

  get settlementPeriod(): Instant {
    return this.#options.settlementPeriod;
  }

  isSettlementAuthority(tokenId: TokenId, account: Address): boolean {
    return this.#options.authority.isSettlementAuthority(tokenId, account);
  }

  settlement(settlementId: Bytes32): Settlement {
    return this.#options.store.settlement(settlementId);
  }

  openGapOf(tokenId: TokenId): Bytes32 {
    return this.#options.store.openGapOf(tokenId);
  }

  /** Whether an open gap has run past its deadline. Expiry is not an outcome. */
  hasExpired(settlementId: Bytes32): boolean {
    const record = this.settlement(settlementId);
    return record.status === 'OPEN' && this.#options.clock.now() > record.deadline;
  }

  /**
   * Open a gap. Only a settlement authority may, the identifier must be fresh,
   * the deadline must be in the future and within the settlement period, and
   * a token may have at most one open gap.
   */
  begin(request: BeginRequest): Settlement {
    const { store, clock } = this.#options;

    if (!isBytes32(request.settlementId) || request.settlementId === ZERO_BYTES32) {
      reject('MALFORMED_ENTRY', 'settlementId must be a non-zero bytes32');
    }
    if (!isAddress(request.initiator) || !isAddress(request.expectedHolder)) {
      reject('MALFORMED_ENTRY', 'initiator and expectedHolder must be addresses');
    }
    if (!isBytes32(request.snapshotHash) || request.snapshotHash === ZERO_BYTES32) {
      reject('MALFORMED_ENTRY', 'snapshotHash must be a non-zero bytes32');
    }
    if (!isUint64(request.deadline)) {
      reject('MALFORMED_ENTRY', 'deadline must be a uint64');
    }
    if (!this.isSettlementAuthority(request.tokenId, request.initiator)) {
      reject('NOT_SETTLEMENT_AUTHORITY', `${request.initiator} may not open a gap on token ${request.tokenId}`);
    }
    if (store.settlement(request.settlementId).status !== 'NONE') {
      reject('SETTLEMENT_EXISTS', `settlement ${request.settlementId} already exists`);
    }

    const now = clock.now();
    if (request.deadline <= now) {
      reject('DEADLINE_OUT_OF_RANGE', 'the deadline is not in the future');
    }
    if (request.deadline - now > this.settlementPeriod) {
      reject('DEADLINE_OUT_OF_RANGE', `the deadline exceeds the settlement period of ${this.settlementPeriod}`);
    }

    return store.openGap(request.tokenId, {
      settlementId: request.settlementId,
      initiator: request.initiator,
      expectedHolder: request.expectedHolder,
      snapshotHash: request.snapshotHash,
      openedAt: now,
      deadline: request.deadline,
    });
  }

  /**
   * Close a gap by admitting the entry it was opened for.
   *
   * Anyone may relay: the submitter is not checked and gains nothing by
   * submitting. What is checked is the proof, and the proof is bound to this
   * settlement, so relaying someone else's proof admits their entry, not one
   * of the relayer's choosing.
   */
  finalize(settlementId: Bytes32, candidate: CandidateEntry, material: ProofMaterial): AdmissionResult {
    const record = this.settlement(settlementId);
    assertSettlementAdmission(record, candidate, this.#options.clock.now());
    return this.#options.store.admit(record.tokenId, candidate, material);
  }

  /**
   * Close a gap without admitting anything.
   *
   * This settles nothing. The projection is untouched, and every instant that
   * was provisional before is provisional after. Only the initiator may cancel,
   * and only strictly after the deadline.
   */
  cancel(settlementId: Bytes32, caller: Address, _reasonHash: Bytes32 = ZERO_BYTES32): Settlement {
    const record = this.settlement(settlementId);
    if (record.status !== 'OPEN') {
      reject('NO_OPEN_GAP', `settlement ${settlementId} is not open`);
    }
    const isInitiator = caller.toLowerCase() === record.initiator.toLowerCase();
    if (!isInitiator) {
      reject('NOT_SETTLEMENT_AUTHORITY', 'only the initiator may cancel a settlement');
    }
    if (!this.hasExpired(settlementId)) {
      reject('DEADLINE_OUT_OF_RANGE', 'cancellation requires a time strictly after the deadline');
    }
    return this.#options.store.cancelGap(record.tokenId);
  }
}
