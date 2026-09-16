import type { Address, Bytes32 } from './types.ts';

/**
 * The watchtower freshness layer.
 *
 * A separate, optional contract that records signed attestations about an
 * asset feed and classifies the recorded head by age. It is not part of
 * `IRegisterProjection` or `IProjectionSettlement`, and nothing it reports is
 * an input to either.
 *
 * What it measures is reorg exposure: whether the block a head was signed at
 * is buried deeply enough that it will not flip. What it does not measure is
 * whether the register has confirmed anything, or whether a projected instant
 * can still change. Collapsing the two would let a downstream consumer read
 * registrar finality out of a check that only guarantees chain immutability.
 */

/** The contract's `Freshness` enum. */
export type Freshness = 'UNKNOWN' | 'STALE' | 'FRESH_PENDING' | 'FRESH_FINAL';

/** Solidity enum ordering. */
export const FRESHNESS_BY_INDEX: readonly Freshness[] = [
  'UNKNOWN',
  'STALE',
  'FRESH_PENDING',
  'FRESH_FINAL',
];

/** `headOf(assetId)`. */
export type WatchtowerHead = {
  readonly signedAtBlock: bigint;
  readonly sequenceNumber: bigint;
  readonly freshnessThreshold: bigint;
  readonly recordedAtBlock: bigint;
  readonly key: Address;
};

/** `policyOf(assetId)`. */
export type WatchtowerPolicy = {
  readonly steward: Address;
  /**
   * Blocks of depth after which a head is classified `FRESH_FINAL`.
   *
   * A reorg-safety depth, on the chain carrying the attestation. It has
   * nothing to do with the projection's finality rule.
   */
  readonly finalityDepth: bigint;
  readonly maxFreshnessThreshold: bigint;
  readonly pendingSteward: Address;
  readonly registered: boolean;
};

export type FreshnessAnswer = {
  readonly status: Freshness;
  /** Blocks elapsed since the head was signed. */
  readonly age: bigint;
};

/**
 * The watchtower read port.
 *
 * Separate from `Erc8415Reader` on purpose. They are different contracts
 * answering different questions, and a single combined reader would invite
 * exactly the conflation the freshness layer must not cause.
 */
export type WatchtowerReader = {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  freshnessOf(assetId: Bytes32): Promise<FreshnessAnswer>;
  headOf(assetId: Bytes32): Promise<WatchtowerHead>;
  policyOf(assetId: Bytes32): Promise<WatchtowerPolicy>;
};
