import type { Address, Bytes32, TokenId } from './types.ts';

/** Application records, NOT ERC-8415 states or a transaction authorization. */
export type LinkedAsset = {
  readonly chainId: bigint;
  readonly contract: Address;
  readonly tokenId: TokenId;
};

export type LinkedLeg = {
  readonly id: Bytes32;
  readonly predecessorId: Bytes32 | null;
  /** Unique occurrence: A -> B -> A must not identify both A positions alike. */
  readonly buyerOccurrenceId: Bytes32;
  readonly seller: Address;
  readonly buyer: Address;
  readonly originalPayer: Address;
  readonly termsHash: Bytes32;
  readonly paymentAsset: Address; // zero address denotes native currency
  readonly principal: bigint;
  /** Actual outcome read from the execution backend, never inferred from the predicate. */
  readonly outcome: 'reserved' | 'released' | 'returning' | 'refunded';
};

export type LinkedChainSnapshot = {
  readonly asset: LinkedAsset;
  readonly sequenceId: Bytes32;
  readonly revision: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: Bytes32;
  readonly initialOccurrenceId: Bytes32;
  readonly initialHolder: Address;
  /** Complete accepted sequence, including detached history. Never a filtered tail. */
  readonly legs: readonly LinkedLeg[];
};

export type LinkedPosition = {
  readonly occurrenceId: Bytes32;
  readonly account: Address;
};

/**
 * The configured evidence adapter must verify these associations. Matching an
 * address in Transfer logs to a register entry is NOT sufficient. A claimed
 * index, apparently-registered history, or an untrusted JSON flag is not proof.
 */
export type LinkedCompletionEvidence =
  | { readonly kind: 'unavailable' | 'ambiguous' }
  | {
      readonly kind: 'bound';
      readonly asset: LinkedAsset;
      readonly sequenceId: Bytes32;
      readonly revision: bigint;
      readonly blockNumber: bigint;
      readonly blockHash: Bytes32;
      readonly owner: LinkedPosition;
      readonly admittedHolder: LinkedPosition;
      /** An independent protocol answer; neither true nor false gates CP-01. */
      readonly protocolFinality: boolean | null;
    };

/**
 * Read-only backend seam. Return one coherent snapshot; authenticate source,
 * conformance, accepted terms, occurrence proofs, outcomes and block identity.
 * No production linked backend is shipped yet. This port cannot release funds.
 */
export type LinkedChainReader = {
  observe(sequenceId: Bytes32): Promise<{
    readonly snapshot: LinkedChainSnapshot;
    readonly evidence: LinkedCompletionEvidence;
  }>;
};
