/**
 * Types mirroring the ERC-8415 interfaces.
 *
 * Every type here corresponds to something `IRegisterProjection` or
 * `IProjectionSettlement` returns. The wallet adds display state elsewhere;
 * this module adds none.
 */
/** Solidity enum ordering of `GapStatus`. */
export const GAP_STATUS_BY_INDEX = [
    'NONE',
    'OPEN',
    'ADMITTED',
    'CANCELLED',
    'SUPERSEDED',
];
/** The zero `bytes32`, returned by `openGapOf` when no gap is open. */
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
/** The zero address. */
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
