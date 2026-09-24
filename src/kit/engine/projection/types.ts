/** 0x-prefixed 20-byte hex, lowercase. */
export type Address = string;

/** 0x-prefixed 32-byte hex, lowercase. `bytes32` on chain. */
export type Bytes32 = string;

export type Commitment = Bytes32;

/** Seconds since the Unix epoch, on the same scale as `block.timestamp`. */
export type Instant = bigint;

export type TokenId = bigint;

/**
 * One admitted entry, mirroring `IRegisterProjection.RegisterEntry`.
 *
 * `supersededAt` is zero on the latest entry and carries the next entry's
 * `effectiveAt` once one is admitted. It is the only field the standard ever
 * writes after admission, it is written exactly once, and the interval it
 * closes is closed by the register — not by the moment the chain learned of
 * the change.
 */
export interface ProjectionEntry {
  readonly recordCommitment: Commitment;
  readonly previousCommitment: Commitment;
  readonly registryReference: Bytes32;
  readonly holder: Address;
  readonly version: bigint;
  readonly effectiveAt: Instant;
  readonly supersededAt: Instant;
}

/** What a submitter supplies. `supersededAt` is never submitted. */
export type CandidateEntry = Omit<ProjectionEntry, 'supersededAt'>;

/** A settlement gap. Mirrors `IProjectionSettlement.Settlement`. */
export type GapStatus = 'NONE' | 'OPEN' | 'ADMITTED' | 'CANCELLED' | 'SUPERSEDED';

export interface Settlement {
  readonly settlementId: Bytes32;
  readonly tokenId: TokenId;
  readonly initiator: Address;
  readonly expectedHolder: Address;
  readonly snapshotHash: Bytes32;
  readonly openedAt: Instant;
  readonly deadline: Instant;
  readonly status: GapStatus;
}

export const ZERO_BYTES32: Bytes32 = `0x${'0'.repeat(64)}`;
export const ZERO_ADDRESS: Address = `0x${'0'.repeat(40)}`;
export const FIRST_VERSION = 1n;
export const UINT64_MAX = (1n << 64n) - 1n;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

export const isAddress = (value: unknown): value is Address =>
  typeof value === 'string' && ADDRESS.test(value);

export const isBytes32 = (value: unknown): value is Bytes32 =>
  typeof value === 'string' && BYTES32.test(value);

export const isUint64 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= UINT64_MAX;
