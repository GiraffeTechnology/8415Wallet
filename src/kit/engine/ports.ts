import type { Instant, TokenId } from './projection/types.ts';

/**
 * The chain the register is projected from. Admission consults it to decide
 * whether the remote state a proof claims inclusion in is finalized.
 *
 * Stage 3 supplies an Ethereum implementation; the memory adapter stands in
 * for it until then. Nothing above this port knows which one it is talking to.
 */
export interface RemoteChainAdapter {
  readonly chainId: bigint;
  readonly contract: string;
  isFinalized(height: bigint): boolean;
  /**
   * The state root accepted for a height, or undefined if no state is
   * accepted there. A proof profile verifies inclusion against this, never
   * against a root a submitter supplies alongside the proof.
   */
  stateRootAt(height: bigint): string | undefined;
  acceptedHeight(tokenId: TokenId): bigint;
  advanceHeight(tokenId: TokenId, height: bigint): void;
}

/** Wall-clock source, injected so tests are deterministic. */
export interface Clock {
  now(): Instant;
}
