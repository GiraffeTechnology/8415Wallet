import {
  ContractRevertError,
  InvariantViolationError,
  ValueOutOfRangeError,
} from '../../sdk/errors.ts';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type Address,
  type Bytes32,
  type Conformance,
  type Instant,
  type RegisterEntry,
  type Settlement,
  type TokenId,
  type Version,
} from '../../sdk/types.ts';
import type { ContractEvent } from './events.ts';

const UINT64_MAX = (1n << 64n) - 1n;

/** What a settlement asks to admit, once its proof verifies. */
export type AdmissionCandidate = {
  readonly recordCommitment: Bytes32;
  readonly registryReference: Bytes32;
  readonly effectiveAt: Instant;
  readonly proofData: string;
};

/**
 * Stands in for the verification profile.
 *
 * The ERC constrains verification and leaves attestation to the profile, so
 * the modelled contract takes one rather than inventing rules. Tests supply a
 * verifier that accepts or rejects, which is what exercises the requirement
 * that a failed admission changes nothing.
 */
export type ProofVerifier = (
  settlement: Settlement,
  candidate: AdmissionCandidate,
) => boolean;

export type MemoryRegisterOptions = {
  readonly chainId?: bigint;
  readonly address?: Address;
  readonly registerId?: Bytes32;
  readonly verificationProfile?: Bytes32;
  readonly settlementPeriod?: bigint;
  /** Start of the modelled `block.timestamp`. */
  readonly now?: Instant;
  /**
   * Profile bound on how far ahead of `now` an `effectiveAt` may sit.
   *
   * The ERC states an implementation SHOULD reject one further ahead than its
   * profile allows, because an unbounded effective time ends the projection
   * for that token permanently. Unset means unbounded, which is the state the
   * wallet's risk surface exists to report.
   */
  readonly maxEffectiveAtDrift?: bigint;
  readonly verifyProof?: ProofVerifier;
  /** Which ERC-165 identifiers this contract advertises. */
  readonly conformance?: Partial<Conformance>;
};

/**
 * An in-memory ERC-8415 contract that enforces the projection invariants.
 *
 * It exists so the wallet can be tested against behaviour the ERC actually
 * requires, rather than against a mock shaped like the wallet's expectations.
 * The four invariants are enforced on admission, the finality rule is the
 * ERC's single comparison, and the settlement lifecycle follows the ERC's
 * ordering — including that a failed admission changes nothing, cancellation
 * leaves the projection untouched, and superseding a gap makes its proof
 * unusable.
 *
 * It is a model, not a reference implementation. Where it and the ERC differ,
 * the ERC is right and this is a bug.
 */
export class MemoryRegisterContract {
  readonly chainId: bigint;
  readonly address: Address;
  readonly registerIdValue: Bytes32;
  readonly verificationProfileValue: Bytes32;
  readonly settlementPeriodValue: bigint;
  readonly conformance: Conformance;

  #now: Instant;
  readonly #maxEffectiveAtDrift: bigint | undefined;
  readonly #verifyProof: ProofVerifier;

  readonly #entries = new Map<string, RegisterEntry[]>();
  readonly #owners = new Map<string, Address>();
  readonly #authorities = new Map<string, Set<Address>>();
  readonly #settlements = new Map<Bytes32, Settlement>();
  readonly #openGaps = new Map<string, Bytes32>();
  readonly #events: ContractEvent[] = [];

  constructor(options: MemoryRegisterOptions = {}) {
    this.chainId = options.chainId ?? 1n;
    this.address = options.address ?? '0x4f2a000000000000000000000000000000000001';
    this.registerIdValue = options.registerId ?? `0x${'9c11'.repeat(16)}`;
    this.verificationProfileValue = options.verificationProfile ?? `0x${'0d7e'.repeat(16)}`;
    this.settlementPeriodValue = options.settlementPeriod ?? 30n * 24n * 60n * 60n;
    this.#now = options.now ?? 1_767_225_600n;
    this.#maxEffectiveAtDrift = options.maxEffectiveAtDrift;
    this.#verifyProof = options.verifyProof ?? (() => true);
    this.conformance = {
      erc165: options.conformance?.erc165 ?? true,
      projection: options.conformance?.projection ?? true,
      settlement: options.conformance?.settlement ?? true,
    };
  }

  // ---------------------------------------------------------------- clock

  get now(): Instant {
    return this.#now;
  }

  /** Advance the modelled `block.timestamp`. Time does not run backwards. */
  advanceTo(instant: Instant): void {
    if (instant < this.#now) {
      throw new ValueOutOfRangeError('block timestamp may not move backwards', instant);
    }
    this.#now = instant;
  }

  get events(): readonly ContractEvent[] {
    return this.#events;
  }

  // ------------------------------------------------------------ ERC-721

  mint(tokenId: TokenId, owner: Address): void {
    if (this.#owners.has(key(tokenId))) {
      throw new ContractRevertError(`token ${tokenId} already exists`);
    }
    this.#owners.set(key(tokenId), owner);
    this.#events.push({ kind: 'Transfer', tokenId, from: ZERO_ADDRESS, to: owner });
  }

  /**
   * An ordinary ERC-721 transfer.
   *
   * Succeeds while a gap is open, and does not touch the projection. Both are
   * required: trading is not blocked, and the confirmed holder moves only
   * through proof-verified admission.
   */
  transfer(tokenId: TokenId, to: Address): void {
    const from = this.ownerOf(tokenId);
    this.#owners.set(key(tokenId), to);
    this.#events.push({ kind: 'Transfer', tokenId, from, to });
  }

  ownerOf(tokenId: TokenId): Address {
    const owner = this.#owners.get(key(tokenId));
    if (owner === undefined) {
      throw new ContractRevertError(`ownerOf: token ${tokenId} does not exist`);
    }
    return owner;
  }

  // -------------------------------------------------------------- reads

  supportsInterface(interfaceId: string): boolean {
    if (!this.conformance.erc165) {
      throw new ContractRevertError('supportsInterface: not implemented');
    }
    if (interfaceId === '0x01ffc9a7') return true;
    if (interfaceId === '0x6309e170') return this.conformance.projection;
    if (interfaceId === '0xf4a7d71b') return this.conformance.settlement;
    return false;
  }

  entryCount(tokenId: TokenId): bigint {
    return BigInt(this.#entriesOf(tokenId).length);
  }

  currentEntry(tokenId: TokenId): RegisterEntry {
    const entries = this.#entriesOf(tokenId);
    const latest = entries[entries.length - 1];
    if (latest === undefined) {
      throw new ContractRevertError(`currentEntry: token ${tokenId} has no entries`);
    }
    return latest;
  }

  entryAt(tokenId: TokenId, version: Version): RegisterEntry {
    const entries = this.#entriesOf(tokenId);
    const entry = version >= 1n ? entries[Number(version - 1n)] : undefined;
    if (entry === undefined) {
      throw new ContractRevertError(`entryAt: token ${tokenId} has no version ${version}`);
    }
    return entry;
  }

  /**
   * The entry whose effective interval contains `instant`.
   *
   * Reverts for an instant preceding the first entry, as specified. The caller
   * is expected to establish that cause from `entryAt(tokenId, 1)` rather than
   * from this message.
   */
  entryAsOf(tokenId: TokenId, instant: Instant): RegisterEntry {
    const entries = this.#entriesOf(tokenId);
    let covering: RegisterEntry | undefined;
    for (const entry of entries) {
      if (entry.effectiveAt <= instant) covering = entry;
      else break;
    }
    if (covering === undefined) {
      throw new ContractRevertError(
        `entryAsOf: instant ${instant} precedes the first entry of token ${tokenId}`,
      );
    }
    return covering;
  }

  holderAsOf(tokenId: TokenId, instant: Instant): Address {
    return this.entryAsOf(tokenId, instant).holder;
  }

  /**
   * The ERC's finality rule, unmodified.
   *
   * Final iff the instant is at or after the first entry's `effectiveAt` and
   * strictly before the latest entry's. Never reverts — including for an
   * instant before the first entry, where it answers false.
   *
   * With a single entry nothing is final: the latest entry's effective time is
   * also the first, so the interval is empty until a later entry closes it.
   */
  isFinalAsOf(tokenId: TokenId, instant: Instant): boolean {
    const entries = this.#entriesOf(tokenId);
    const first = entries[0];
    const latest = entries[entries.length - 1];
    if (first === undefined || latest === undefined) return false;
    return instant >= first.effectiveAt && instant < latest.effectiveAt;
  }

  registerId(): Bytes32 {
    return this.registerIdValue;
  }

  verificationProfile(): Bytes32 {
    this.#requireSettlementConformance('verificationProfile');
    return this.verificationProfileValue;
  }

  settlementPeriod(): bigint {
    this.#requireSettlementConformance('settlementPeriod');
    return this.settlementPeriodValue;
  }

  settlement(settlementId: Bytes32): Settlement {
    this.#requireSettlementConformance('settlement');
    const record = this.#settlements.get(settlementId);
    if (record === undefined) {
      throw new ContractRevertError(`settlement: unknown identifier ${settlementId}`);
    }
    return record;
  }

  /** Zero when no gap is open. */
  openGapOf(tokenId: TokenId): Bytes32 {
    this.#requireSettlementConformance('openGapOf');
    return this.#openGaps.get(key(tokenId)) ?? ZERO_BYTES32;
  }

  /** Reverts for a nonexistent token, as specified. Not satisfied by `ownerOf`. */
  isSettlementAuthority(tokenId: TokenId, account: Address): boolean {
    this.#requireSettlementConformance('isSettlementAuthority');
    if (!this.#owners.has(key(tokenId))) {
      throw new ContractRevertError(`isSettlementAuthority: token ${tokenId} does not exist`);
    }
    return this.#authorities.get(key(tokenId))?.has(account) ?? false;
  }

  /** Scenario setup: grant the registrar authority over a token. */
  grantSettlementAuthority(tokenId: TokenId, account: Address): void {
    const existing = this.#authorities.get(key(tokenId)) ?? new Set<Address>();
    existing.add(account);
    this.#authorities.set(key(tokenId), existing);
  }

  // ------------------------------------------------------------- writes

  beginSettlement(
    caller: Address,
    tokenId: TokenId,
    settlementId: Bytes32,
    expectedHolder: Address,
    snapshotHash: Bytes32,
    deadline: Instant,
  ): void {
    this.#requireSettlementConformance('beginSettlement');
    if (!this.#owners.has(key(tokenId))) {
      throw new ContractRevertError(`beginSettlement: token ${tokenId} does not exist`);
    }
    if (settlementId === ZERO_BYTES32) {
      throw new ContractRevertError('beginSettlement: settlementId must be nonzero');
    }
    if (this.#settlements.has(settlementId)) {
      throw new ContractRevertError('beginSettlement: settlementId already used');
    }
    if (snapshotHash === ZERO_BYTES32) {
      throw new ContractRevertError('beginSettlement: snapshot must be nonzero');
    }
    if (!this.isSettlementAuthority(tokenId, caller)) {
      throw new ContractRevertError('beginSettlement: caller is not a settlement authority');
    }
    if (deadline <= this.#now) {
      throw new ContractRevertError('beginSettlement: deadline must be in the future');
    }
    if (deadline - this.#now > this.settlementPeriodValue) {
      throw new ContractRevertError('beginSettlement: deadline exceeds the settlement period');
    }

    // At most one open gap. Beginning another supersedes it and leaves the
    // projection unchanged; any proof already produced for it becomes unusable.
    const openId = this.#openGaps.get(key(tokenId));
    if (openId !== undefined) {
      const superseded = this.#settlements.get(openId)!;
      this.#settlements.set(openId, { ...superseded, status: 'SUPERSEDED' });
      this.#events.push({
        kind: 'SettlementSuperseded',
        supersededId: openId,
        replacementId: settlementId,
        tokenId,
      });
    }

    this.#settlements.set(settlementId, {
      tokenId,
      initiator: caller,
      expectedHolder,
      snapshotHash,
      openedAt: this.#now,
      deadline,
      status: 'OPEN',
    });
    this.#openGaps.set(key(tokenId), settlementId);
    this.#events.push({
      kind: 'SettlementStarted',
      settlementId,
      tokenId,
      initiator: caller,
      expectedHolder,
      snapshotHash,
      deadline,
    });
  }

  /**
   * Admit an entry into an open gap.
   *
   * Permissionless: proof validity is never derived from the caller. Every
   * effect happens together — the entry is appended, the prior entry's
   * interval is closed, and the gap closes — or none does.
   */
  finalizeSettlement(settlementId: Bytes32, candidate: AdmissionCandidate): void {
    this.#requireSettlementConformance('finalizeSettlement');
    const record = this.#settlements.get(settlementId);
    if (record === undefined) {
      throw new ContractRevertError(`finalizeSettlement: unknown settlement ${settlementId}`);
    }
    if (record.status !== 'OPEN') {
      throw new ContractRevertError(
        `finalizeSettlement: settlement is ${record.status}, not OPEN`,
      );
    }
    if (!this.#verifyProof(record, candidate)) {
      throw new ContractRevertError('finalizeSettlement: proof rejected by the profile');
    }

    // The append is validated before anything mutates, so a rejected entry
    // leaves no trace: the gap stays open and the projection is untouched.
    const appended = this.#appendEntry(record.tokenId, record.expectedHolder, candidate);

    this.#settlements.set(settlementId, { ...record, status: 'ADMITTED' });
    this.#openGaps.delete(key(record.tokenId));

    this.#events.push({
      kind: 'SettlementFinalized',
      settlementId,
      tokenId: record.tokenId,
      recordCommitment: appended.recordCommitment,
      version: appended.version,
      effectiveAt: appended.effectiveAt,
    });
  }

  /**
   * Cancel an open gap, after its deadline.
   *
   * Ends the contest and settles nothing: the projection is unchanged, the
   * preceding entry stays in force, and no instant becomes final. Cancelling
   * before the deadline is rejected so a record already finalized remotely
   * cannot be stranded by unilateral abandonment.
   */
  cancelSettlement(caller: Address, settlementId: Bytes32, reasonHash: Bytes32): void {
    this.#requireSettlementConformance('cancelSettlement');
    const record = this.#settlements.get(settlementId);
    if (record === undefined) {
      throw new ContractRevertError(`cancelSettlement: unknown settlement ${settlementId}`);
    }
    if (record.status !== 'OPEN') {
      throw new ContractRevertError(`cancelSettlement: settlement is ${record.status}, not OPEN`);
    }
    if (caller !== record.initiator) {
      throw new ContractRevertError('cancelSettlement: caller is not the recorded initiator');
    }
    if (this.#now <= record.deadline) {
      throw new ContractRevertError('cancelSettlement: deadline has not passed');
    }

    this.#settlements.set(settlementId, { ...record, status: 'CANCELLED' });
    this.#openGaps.delete(key(record.tokenId));
    this.#events.push({
      kind: 'SettlementCancelled',
      settlementId,
      tokenId: record.tokenId,
      reasonHash,
    });
  }

  // --------------------------------------------------------- invariants

  /**
   * Place entries without going through a settlement.
   *
   * For contracts that maintain a projection by other means: the ERC allows
   * that, and discovers the two conformance levels separately. The invariants
   * are enforced identically, because they are properties of the projection
   * rather than of the path that wrote it.
   */
  seedEntries(
    tokenId: TokenId,
    specs: readonly { holder: Address; effectiveAt: Instant; seed: string }[],
  ): void {
    for (const spec of specs) {
      this.#appendEntry(tokenId, spec.holder, {
        recordCommitment: `0x${spec.seed.repeat(64).slice(0, 64)}`,
        registryReference: `0x${`f${spec.seed}`.repeat(32).slice(0, 64)}`,
        effectiveAt: spec.effectiveAt,
        proofData: '0x',
      });
    }
  }

  /**
   * Append an entry, closing the prior entry's interval, and emit.
   *
   * Invariants are checked first and the whole append either happens or does
   * not: the prior entry's `supersededAt` is never left moved by a rejected
   * admission.
   */
  #appendEntry(
    tokenId: TokenId,
    holder: Address,
    candidate: AdmissionCandidate,
  ): RegisterEntry {
    const appended = this.#buildEntry(tokenId, holder, candidate);

    const entries = this.#entriesOf(tokenId);
    const prior = entries[entries.length - 1];
    if (prior !== undefined) {
      // The register closes the prior interval, at the new entry's effective
      // time — not at the moment the chain learned of it.
      entries[entries.length - 1] = { ...prior, supersededAt: appended.effectiveAt };
    }
    entries.push(appended);
    this.#entries.set(key(tokenId), entries);

    if (appended.version === 1n) {
      this.#events.push({
        kind: 'RegisterInitialized',
        tokenId,
        recordCommitment: appended.recordCommitment,
        holder: appended.holder,
        version: appended.version,
        effectiveAt: appended.effectiveAt,
      });
    } else {
      this.#events.push({
        kind: 'RegisterSuperseded',
        tokenId,
        version: appended.version,
        recordCommitment: appended.recordCommitment,
        previousCommitment: appended.previousCommitment,
        holder: appended.holder,
        effectiveAt: appended.effectiveAt,
      });
    }
    return appended;
  }

  /**
   * Build the entry an admission would append, enforcing the four projection
   * invariants. Throws without mutating if any is violated.
   */
  #buildEntry(
    tokenId: TokenId,
    holder: Address,
    candidate: AdmissionCandidate,
  ): RegisterEntry {
    const entries = this.#entriesOf(tokenId);
    const prior = entries[entries.length - 1];

    if (candidate.effectiveAt < 0n || candidate.effectiveAt > UINT64_MAX) {
      throw new ValueOutOfRangeError('effectiveAt', candidate.effectiveAt);
    }
    if (candidate.recordCommitment === ZERO_BYTES32) {
      throw new InvariantViolationError('commitment', 'a record commitment must be nonzero');
    }
    // Invariant 4: a commitment is unique within a token's chain of entries.
    if (entries.some((entry) => entry.recordCommitment === candidate.recordCommitment)) {
      throw new InvariantViolationError(
        '4 — commitment uniqueness',
        `commitment ${candidate.recordCommitment} already appears in token ${tokenId}`,
      );
    }
    if (
      this.#maxEffectiveAtDrift !== undefined &&
      candidate.effectiveAt > this.#now + this.#maxEffectiveAtDrift
    ) {
      throw new InvariantViolationError(
        'profile bound on effectiveAt drift',
        `effectiveAt ${candidate.effectiveAt} is further ahead than the profile allows`,
      );
    }

    if (prior === undefined) {
      // Invariant 1: the first entry is version 1 with a zero previous commitment.
      return {
        recordCommitment: candidate.recordCommitment,
        previousCommitment: ZERO_BYTES32,
        registryReference: candidate.registryReference,
        holder,
        version: 1n,
        effectiveAt: candidate.effectiveAt,
        supersededAt: 0n,
      };
    }

    // Invariant 3: effective times strictly increase. Equal times are forbidden,
    // because an instant shared by two entries would have two answers.
    if (candidate.effectiveAt <= prior.effectiveAt) {
      throw new InvariantViolationError(
        '3 — strictly increasing effectiveAt',
        `effectiveAt ${candidate.effectiveAt} does not exceed the preceding ${prior.effectiveAt}`,
      );
    }

    // Invariant 2: append version n+1 and link the prior commitment.
    return {
      recordCommitment: candidate.recordCommitment,
      previousCommitment: prior.recordCommitment,
      registryReference: candidate.registryReference,
      holder,
      version: prior.version + 1n,
      effectiveAt: candidate.effectiveAt,
      supersededAt: 0n,
    };
  }

  #entriesOf(tokenId: TokenId): RegisterEntry[] {
    const existing = this.#entries.get(key(tokenId));
    if (existing !== undefined) return existing;
    const created: RegisterEntry[] = [];
    this.#entries.set(key(tokenId), created);
    return created;
  }

  #requireSettlementConformance(call: string): void {
    if (!this.conformance.settlement) {
      throw new ContractRevertError(`${call}: contract offers no settlement interface`);
    }
  }
}

function key(tokenId: TokenId): string {
  return tokenId.toString();
}
