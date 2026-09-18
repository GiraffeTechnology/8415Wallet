import type { RemoteChainAdapter } from '../../engine/ports.ts';
import type { TokenId } from '../../engine/projection/types.ts';

export interface MemoryChainOptions {
  readonly chainId?: bigint;
  readonly contract?: string;
  /** Heights at or below this are treated as finalized. */
  readonly finalizedThrough?: bigint;
}

/**
 * Stands in for a chain so admission and the temporal queries can run without
 * one. Stage 3 replaces it with an Ethereum adapter behind the same port; the
 * engine cannot tell the difference.
 */
export class MemoryChainAdapter implements RemoteChainAdapter {
  readonly chainId: bigint;
  readonly contract: string;
  #finalizedThrough: bigint;
  readonly #heights = new Map<string, bigint>();
  readonly #roots = new Map<string, string>();

  constructor(options: MemoryChainOptions = {}) {
    this.chainId = options.chainId ?? 1n;
    this.contract = options.contract ?? '0x' + '11'.repeat(20);
    this.#finalizedThrough = options.finalizedThrough ?? (1n << 32n);
  }

  isFinalized(height: bigint): boolean {
    return height > 0n && height <= this.#finalizedThrough;
  }

  stateRootAt(height: bigint): string | undefined {
    return this.#roots.get(height.toString());
  }

  /** Test control: publish an accepted state root at a height. */
  setStateRoot(height: bigint, root: string): void {
    this.#roots.set(height.toString(), root);
  }

  acceptedHeight(tokenId: TokenId): bigint {
    return this.#heights.get(tokenId.toString()) ?? 0n;
  }

  advanceHeight(tokenId: TokenId, height: bigint): void {
    this.#heights.set(tokenId.toString(), height);
  }

  /** Test control: move the finalized frontier. */
  setFinalizedThrough(height: bigint): void {
    this.#finalizedThrough = height;
  }
}
