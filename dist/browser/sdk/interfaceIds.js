import { keccak256Utf8 } from "../codec/keccak.js";
/**
 * Canonical function signatures of the two ERC-8415 interfaces.
 *
 * `supportsInterface(bytes4)` is inherited from ERC-165 and is excluded from
 * the interface-id fold, as the ERC specifies.
 */
export const REGISTER_PROJECTION_SIGNATURES = [
    'currentEntry(uint256)',
    'entryAt(uint256,uint64)',
    'entryAsOf(uint256,uint64)',
    'holderAsOf(uint256,uint64)',
    'isFinalAsOf(uint256,uint64)',
    'entryCount(uint256)',
    'registerId()',
];
export const PROJECTION_SETTLEMENT_SIGNATURES = [
    'settlement(bytes32)',
    'openGapOf(uint256)',
    'settlementPeriod()',
    'verificationProfile()',
    'isSettlementAuthority(uint256,address)',
    'beginSettlement(uint256,bytes32,address,bytes32,uint64)',
    'finalizeSettlement(bytes32,bytes32,bytes32,uint64,bytes)',
    'cancelSettlement(bytes32,bytes32)',
];
/** Four-byte selector of a canonical function signature. */
export function selectorOf(signature) {
    return keccak256Utf8(signature).slice(0, 10);
}
/** XOR fold of a signature list, as the ERC-165 identifier convention requires. */
export function foldInterfaceId(signatures) {
    const folded = signatures.reduce((accumulator, signature) => accumulator ^ Number.parseInt(selectorOf(signature).slice(2), 16), 0);
    return `0x${(folded >>> 0).toString(16).padStart(8, '0')}`;
}
/**
 * Frozen interface identifiers, quoted from the ERC.
 *
 * These are constants of the standard, not of this wallet. `tests/
 * interfaceIds.test.ts` recomputes them from the signatures above and fails if
 * they drift, which also proves the wallet's selector derivation is sound.
 */
export const INTERFACE_ID_ERC165 = '0x01ffc9a7';
export const INTERFACE_ID_REGISTER_PROJECTION = '0x6309e170';
export const INTERFACE_ID_PROJECTION_SETTLEMENT = '0xf4a7d71b';
