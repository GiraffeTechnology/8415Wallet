/**
 * Types mirroring the ERC-8415 interfaces.
 *
 * Every type here corresponds to something `IRegisterProjection` or
 * `IProjectionSettlement` returns. The wallet adds display state elsewhere;
 * this module adds none.
 */

/** A 20-byte address, `0x`-prefixed lowercase hex. */
export type Address = string;

/** A 32-byte value, `0x`-prefixed lowercase hex. */
export type Bytes32 = string;

/** A 4-byte ERC-165 interface identifier, `0x`-prefixed lowercase hex. */
export type Bytes4 = string;

/** `uint256` token identifier. */
export type TokenId = bigint;

/**
 * An instant: `uint64` seconds since the Unix epoch, on the same scale as
 * `block.timestamp`.
 *
 * Held as `bigint` rather than `number` deliberately. A conforming contract
 * may carry an `effectiveAt` anywhere in `uint64`, and the ERC names a
 * far-future effective time as a state a consumer must be able to see
 * accurately — it permanently ends the projection for that token. Narrowing to
 * a double would lose exactly the values worth reporting.
 */
export type Instant = bigint;

/** `uint64` entry version, consecutive from 1. */
export type Version = bigint;

/** One admitted entry, as returned by `currentEntry`, `entryAt`, `entryAsOf`. */
export type RegisterEntry = {
  /** Nonzero commitment to the register's content at this entry, unique per token. */
  readonly recordCommitment: Bytes32;
  /** Link to the prior entry's commitment; zero for the first entry. */
  readonly previousCommitment: Bytes32;
  /**
   * Locator for the register's own record of this entry.
   *
   * Opaque. The wallet never interprets it, and never renders it as resolved
   * content: the chain carries the reference, not the record.
   */
  readonly registryReference: Bytes32;
  /** The confirmed holder. Not `ownerOf`. */
  readonly holder: Address;
  readonly version: Version;
  /** When this entry takes effect. Strictly increasing within a token. */
  readonly effectiveAt: Instant;
  /** When the register closed this entry's interval; zero for the latest entry. */
  readonly supersededAt: Instant;
};

/**
 * Settlement lifecycle status.
 *
 * A union rather than a numeric enum, so an unmapped on-chain value cannot be
 * silently rendered as a neighbouring state. `NONE` is the internal zero value
 * and is never returned by a successful query for a known identifier.
 */
export type GapStatus = 'NONE' | 'OPEN' | 'ADMITTED' | 'CANCELLED' | 'SUPERSEDED';

/** Solidity enum ordering of `GapStatus`. */
export const GAP_STATUS_BY_INDEX: readonly GapStatus[] = [
  'NONE',
  'OPEN',
  'ADMITTED',
  'CANCELLED',
  'SUPERSEDED',
];

/** A settlement record, as returned by `settlement(settlementId)`. */
export type Settlement = {
  readonly tokenId: TokenId;
  readonly initiator: Address;
  /** The holder the settlement asserts; equal to the current one for a confirming entry. */
  readonly expectedHolder: Address;
  readonly snapshotHash: Bytes32;
  /** Block timestamp at which `beginSettlement` succeeded. Bounds the contested interval. */
  readonly openedAt: Instant;
  readonly deadline: Instant;
  readonly status: GapStatus;
};

/** The zero `bytes32`, returned by `openGapOf` when no gap is open. */
export const ZERO_BYTES32: Bytes32 = `0x${'0'.repeat(64)}`;

/** The zero address. */
export const ZERO_ADDRESS: Address = `0x${'0'.repeat(40)}`;

/** Which ERC-8415 conformance levels a contract advertises. */
export type Conformance = {
  /** ERC-165 itself is answered. */
  readonly erc165: boolean;
  /** `0x6309e170` — projection conformance. */
  readonly projection: boolean;
  /** `0xf4a7d71b` — settlement conformance. Discovered separately. */
  readonly settlement: boolean;
};
