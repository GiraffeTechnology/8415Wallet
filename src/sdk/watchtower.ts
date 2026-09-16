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
  /**
   * Derive a feed identifier from its registrar and salt.
   *
   * Asked of the contract rather than recomputed locally: the namespace it
   * hashes under is the deployment's, not something the wallet should assume.
   */
  computeAssetId(registrar: Address, salt: Bytes32): Promise<Bytes32>;
};

/**
 * Which watchtower feed a projection is being read alongside.
 *
 * There is no on-chain link between an ERC-8415 `registerId` and a watchtower
 * `assetId`: the two contracts do not know about each other. A binding is
 * therefore an assertion by whoever configured the wallet, and the wallet says
 * so wherever it shows freshness rather than implying the pairing was checked.
 */
export type WatchtowerBinding = {
  readonly reader: WatchtowerReader;
  readonly assetId: Bytes32;
  /** `computed` means derived through `computeAssetId`; `configured` means supplied. */
  readonly provenance: 'configured' | 'computed';
  /** The register this feed is asserted to track, for display alongside. */
  readonly claimedRegisterId?: Bytes32;
};

/** Derive a feed identifier and return it as a binding. */
export async function bindByRegistrar(
  reader: WatchtowerReader,
  registrar: Address,
  salt: Bytes32,
  claimedRegisterId?: Bytes32,
): Promise<WatchtowerBinding> {
  return {
    reader,
    assetId: await reader.computeAssetId(registrar, salt),
    provenance: 'computed',
    ...(claimedRegisterId === undefined ? {} : { claimedRegisterId }),
  };
}
