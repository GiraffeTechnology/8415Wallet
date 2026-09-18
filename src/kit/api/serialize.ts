import { ZERO_BYTES32, type ProjectionEntry, type Settlement } from '../engine/projection/types.ts';

/**
 * Wire shapes. Every uint64 and uint256 crosses as a decimal string: an instant, a version
 * or a token id can exceed what a JSON number holds exactly, and a silently
 * rounded instant would resolve to the wrong entry.
 */
export const entryJson = (entry: ProjectionEntry) => ({
  version: entry.version.toString(),
  holder: entry.holder,
  effectiveAt: entry.effectiveAt.toString(),
  supersededAt: entry.supersededAt.toString(),
  recordCommitment: entry.recordCommitment,
  previousCommitment: entry.previousCommitment,
  registryReference: entry.registryReference,
});

export const settlementJson = (record: Settlement) => ({
  settlementId: record.settlementId,
  tokenId: record.tokenId.toString(),
  initiator: record.initiator,
  expectedHolder: record.expectedHolder,
  snapshotHash: record.snapshotHash,
  openedAt: record.openedAt.toString(),
  deadline: record.deadline.toString(),
  status: record.status,
});

export const NO_GAP = ZERO_BYTES32;

const UINT64_MAX = (1n << 64n) - 1n;

/** Parse a path segment as a uint64, rejecting anything else. */
export const parseUint64 = (raw: string): bigint | undefined => {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = BigInt(raw);
  return value <= UINT64_MAX ? value : undefined;
};


/** ERC-721 token identifiers cover the full uint256 domain. */
export const parseUint256 = (raw: string): bigint | undefined => {
  if (raw.length > 78 || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = BigInt(raw);
  return value < (1n << 256n) ? value : undefined;
};
