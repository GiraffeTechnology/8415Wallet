import type { Address, Bytes32, Instant, TokenId, Version } from '../../sdk/types.ts';

/**
 * Events the modelled contract emits.
 *
 * Both sequences are recorded: the projection entries and the ERC-721
 * ownership changes they sit alongside. A history view that showed only one of
 * them would be showing half the record.
 */
export type ContractEvent =
  | {
      readonly kind: 'RegisterInitialized';
      readonly tokenId: TokenId;
      readonly recordCommitment: Bytes32;
      readonly holder: Address;
      readonly version: Version;
      readonly effectiveAt: Instant;
    }
  | {
      readonly kind: 'RegisterSuperseded';
      readonly tokenId: TokenId;
      readonly version: Version;
      readonly recordCommitment: Bytes32;
      readonly previousCommitment: Bytes32;
      readonly holder: Address;
      readonly effectiveAt: Instant;
    }
  | {
      readonly kind: 'SettlementStarted';
      readonly settlementId: Bytes32;
      readonly tokenId: TokenId;
      readonly initiator: Address;
      readonly expectedHolder: Address;
      readonly snapshotHash: Bytes32;
      readonly deadline: Instant;
    }
  | {
      readonly kind: 'SettlementFinalized';
      readonly settlementId: Bytes32;
      readonly tokenId: TokenId;
      readonly recordCommitment: Bytes32;
      readonly version: Version;
      readonly effectiveAt: Instant;
    }
  | {
      readonly kind: 'SettlementCancelled';
      readonly settlementId: Bytes32;
      readonly tokenId: TokenId;
      readonly reasonHash: Bytes32;
    }
  | {
      readonly kind: 'SettlementSuperseded';
      readonly supersededId: Bytes32;
      readonly replacementId: Bytes32;
      readonly tokenId: TokenId;
    }
  | {
      readonly kind: 'Transfer';
      readonly tokenId: TokenId;
      readonly from: Address;
      readonly to: Address;
    };
