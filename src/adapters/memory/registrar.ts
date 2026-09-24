import { keccak256Utf8 } from '../../codec/keccak.ts';
import type { Address, Bytes32, Instant, TokenId } from '../../sdk/types.ts';
import type { MemoryRegisterContract } from './register.ts';

/**
 * A register that records changes some time after they happen.
 *
 * Everything else in this repository models the projection once it exists.
 * This models the institution that produces it, because the gap between a
 * transfer and its record is the thing ERC-8415 exists for, and a fixture in
 * which the parties admit their own entries the moment they trade does not
 * contain that gap at all. The first Sepolia run had exactly that shape: the
 * register's validators were the two counterparties, and the admission
 * followed the trade by about a minute because someone ran the next command.
 *
 * Three properties are modelled, and each of them changes what a wallet must
 * show.
 *
 * **It is slower than the chain.** A position can move in thirty seconds while
 * the register takes three minutes to record the move. During that window the
 * token has an owner the register does not confirm, which is the normal state
 * of a trade in flight and not a fault.
 *
 * **It is serial.** The register records one hop at a time — a→b, then b→c,
 * then c→d — so hops that happen while it is working queue up behind the one
 * in hand. A token can be several moves ahead of its own record.
 *
 * **It backdates.** An entry admitted at 12:03 for a transfer that happened at
 * 12:00 carries `effectiveAt` of 12:00, not 12:03. This is what makes a past
 * instant resolvable at all: the record says when the change took effect, not
 * when the registrar got round to it. It also means finality arrives in
 * arrears — an instant becomes final only once a *later* entry exists, so each
 * hop settles the one before it.
 *
 * It is a register, not a tribunal. It records what happened. It does not
 * approve, reject, or decide anything, and there is no method here that could.
 */

export type RegistrarOptions = {
  /** How long the register takes to record one change, in seconds. */
  readonly registrationLatency: Instant;
  /** The account the contract recognises as able to open a gap. */
  readonly registrar: Address;
  /** How long a gap may stay open before it can be cancelled. */
  readonly commitmentWindow?: Instant;
};

/** One change the register has been told about and has not yet recorded. */
export type PendingChange = {
  readonly tokenId: TokenId;
  readonly holder: Address;
  /** When the change took effect — the instant the position moved. */
  readonly effectiveAt: Instant;
  /** The earliest instant the register could finish recording it. */
  readonly recordableAt: Instant;
};

const DEFAULT_COMMITMENT_WINDOW = 7n * 24n * 60n * 60n;

export class AsynchronousRegistrar {
  readonly #contract: MemoryRegisterContract;
  readonly #options: RegistrarOptions;
  /** Strictly first-in, first-out. The register does not reorder its work. */
  readonly #queue: PendingChange[] = [];
  #openGapFor: { tokenId: TokenId; settlementId: Bytes32 } | undefined;
  #sequence = 0;
  /** When the register finishes what it is holding and can start the next. */
  #freeAt: Instant | undefined;

  constructor(contract: MemoryRegisterContract, options: RegistrarOptions) {
    this.#contract = contract;
    this.#options = options;
  }

  /** What the register has been told about and has not yet recorded. */
  get pending(): readonly PendingChange[] {
    return [...this.#queue];
  }

  /**
   * A position moves on chain, and the register is told.
   *
   * The transfer happens now; the record is due one registration latency
   * later. Nothing about the projection changes here — that is the whole
   * point — and `ownerOf` moves immediately, as the standard requires.
   */
  observeTransfer(tokenId: TokenId, to: Address): PendingChange {
    const effectiveAt = this.#contract.now;
    this.#contract.transfer(tokenId, to);

    // Serial, not parallel. The register starts this change when it finishes
    // the one before it, not when it is told — so a token changing hands
    // faster than the register works falls further behind with every hop,
    // which is the whole reason a consumer needs to ask about an instant
    // rather than about now.
    const startsAt =
      this.#freeAt === undefined || this.#freeAt < effectiveAt ? effectiveAt : this.#freeAt;
    const recordableAt = startsAt + this.#options.registrationLatency;
    this.#freeAt = recordableAt;

    const change: PendingChange = { tokenId, holder: to, effectiveAt, recordableAt };
    this.#queue.push(change);
    return change;
  }

  /** How far behind the register is right now, in seconds. */
  backlogAt(instant: Instant): Instant {
    const oldest = this.#queue[0];
    return oldest === undefined ? 0n : instant - oldest.effectiveAt;
  }

  /**
   * Move the clock, recording whatever has come due along the way.
   *
   * Work is done one item at a time and in order. Advancing past several due
   * dates at once records several changes, but never out of sequence and never
   * in parallel: a register that skipped ahead to the newest change would
   * leave the instants in between resolving to the wrong holder forever,
   * because entries are append-only and their effective times must increase.
   */
  advanceTo(instant: Instant): void {
    while (this.#queue.length > 0) {
      const next = this.#queue[0]!;
      if (next.recordableAt > instant) break;
      this.#contract.advanceTo(next.recordableAt);
      this.#record(next);
      this.#queue.shift();
    }
    if (this.#contract.now < instant) this.#contract.advanceTo(instant);
  }

  /**
   * Open a gap for the change in hand, then admit it.
   *
   * Both halves happen at the recording instant, which is what a register
   * doing its work looks like: the gap is the register saying "I am recording
   * this now", and the entry is the record. A consumer watching only the entry
   * walk would see neither until it was over.
   */
  #record(change: PendingChange): void {
    const settlementId = this.#identifier('settlement', change);
    this.#contract.beginSettlement(
      this.#options.registrar,
      change.tokenId,
      settlementId,
      change.holder,
      this.#identifier('snapshot', change),
      this.#contract.now + (this.#options.commitmentWindow ?? DEFAULT_COMMITMENT_WINDOW),
    );
    this.#openGapFor = { tokenId: change.tokenId, settlementId };

    this.#contract.finalizeSettlement(settlementId, {
      recordCommitment: this.#identifier('commitment', change),
      registryReference: this.#identifier('reference', change),
      // Backdated on purpose: when it took effect, not when it was recorded.
      effectiveAt: change.effectiveAt,
      proofData: '0x',
    });
    this.#openGapFor = undefined;
  }

  /**
   * Open the gap for the next change without admitting it.
   *
   * Used to hold a register mid-work, which is the state a wallet most needs
   * to render correctly: a change is in flight, the instants it covers are
   * contested, and nothing has settled.
   */
  beginRecordingNext(): PendingChange | undefined {
    const next = this.#queue[0];
    if (next === undefined) return undefined;
    if (this.#contract.now < next.recordableAt) this.#contract.advanceTo(next.recordableAt);
    const settlementId = this.#identifier('settlement', next);
    this.#contract.beginSettlement(
      this.#options.registrar,
      next.tokenId,
      settlementId,
      next.holder,
      this.#identifier('snapshot', next),
      this.#contract.now + (this.#options.commitmentWindow ?? DEFAULT_COMMITMENT_WINDOW),
    );
    this.#openGapFor = { tokenId: next.tokenId, settlementId };
    return next;
  }

  /** Finish the change begun by `beginRecordingNext`. */
  finishRecording(): void {
    const open = this.#openGapFor;
    const next = this.#queue[0];
    if (open === undefined || next === undefined) return;
    this.#contract.finalizeSettlement(open.settlementId, {
      recordCommitment: this.#identifier('commitment', next),
      registryReference: this.#identifier('reference', next),
      effectiveAt: next.effectiveAt,
      proofData: '0x',
    });
    this.#openGapFor = undefined;
    this.#queue.shift();
  }

  /**
   * A distinct 32-byte value per change and role.
   *
   * A counter goes into the hash so that two changes with identical fields
   * still get different commitments: the projection requires commitments to be
   * unique within a token, and a fixture that produced colliding ones would be
   * testing the contract's rejection rather than the register's behaviour.
   */
  #identifier(role: string, change: PendingChange): Bytes32 {
    this.#sequence += 1;
    return keccak256Utf8(
      `${role}:${change.tokenId}:${change.holder}:${change.effectiveAt}:${this.#sequence}`,
    );
  }
}
