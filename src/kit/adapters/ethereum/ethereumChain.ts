import type { JsonRpcTransport } from './transport.ts';
import type { RemoteChainAdapter } from '../../engine/ports.ts';
import { isAddress, isBytes32, type TokenId } from '../../engine/projection/types.ts';

export interface EthereumChainOptions {
  readonly transport: JsonRpcTransport;
  readonly chainId: bigint;
  readonly contract: string;
  /** Trusted application contract/getter returning the SHA-256 admission-tree root. */
  readonly applicationRoot: { readonly contract: string; readonly callData: string };
}

/**
 * The chain a register is projected from, behind the same port the memory
 * adapter implements.
 *
 * Finality here is the chain's own finalized head, and it answers exactly one
 * question: may a proof claiming this height be considered against accepted
 * remote state. It is not the projection's finality, which is the
 * later-admission rule and lives in the kernel. Block depth never finalises an
 * instant.
 *
 * `refresh` is the monitoring step: it pulls the finalized head and its state
 * application root. The configured RPC is trusted; this is not Ethereum MPT
 * verification. Callers drive it; nothing here polls on its own.
 */
export class EthereumChainAdapter implements RemoteChainAdapter {
  readonly chainId: bigint;
  readonly contract: string;
  readonly #transport: JsonRpcTransport;
  readonly #applicationRoot: EthereumChainOptions['applicationRoot'];
  readonly #hashes = new Map<string, string>();
  readonly #roots = new Map<string, string>();
  readonly #heights = new Map<string, bigint>();
  #finalizedHeight = 0n;

  constructor(options: EthereumChainOptions) {
    this.chainId = options.chainId;
    this.contract = options.contract;
    this.#transport = options.transport;
    if (!isAddress(options.applicationRoot.contract) || !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(options.applicationRoot.callData)) {
      throw new Error('application root requires a contract address and encoded getter call');
    }
    this.#applicationRoot = Object.freeze({ ...options.applicationRoot });
  }

  get finalizedHeight(): bigint {
    return this.#finalizedHeight;
  }

  /** Read the application root at one canonical finalized block, trusting the RPC. */
  async refresh(): Promise<bigint> {
    const block = await this.#transport.send({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
    if (typeof block !== 'object' || block === null) {
      throw new Error('eth_getBlockByNumber returned no block');
    }
    const { number, hash } = block as { number?: unknown; hash?: unknown };
    if (typeof number !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(number) || !isBytes32(hash)) {
      throw new Error('finalized block is missing a valid number or hash');
    }
    const height = BigInt(number);
    const root = await this.#transport.send({ method: 'eth_call', params: [
      { to: this.#applicationRoot.contract, data: this.#applicationRoot.callData },
      { blockHash: hash, requireCanonical: true },
    ] });
    if (!isBytes32(root)) throw new Error('application root getter must return exactly bytes32');
    // Recheck after the asynchronous call: concurrent refreshes cannot rewind state.
    if (height < this.#finalizedHeight) {
      throw new Error(`finalized head moved backwards: ${height} < ${this.#finalizedHeight}`);
    }
    const key = height.toString();
    const knownHash = this.#hashes.get(key);
    const knownRoot = this.#roots.get(key);
    if ((knownHash !== undefined && knownHash !== hash.toLowerCase()) ||
        (knownRoot !== undefined && knownRoot !== root.toLowerCase())) {
      throw new Error('finalized application root changed');
    }
    this.#finalizedHeight = height;
    this.#hashes.set(key, hash.toLowerCase());
    this.#roots.set(key, root.toLowerCase());
    return height;
  }

  isFinalized(height: bigint): boolean {
    return height > 0n && height <= this.#finalizedHeight;
  }

  stateRootAt(height: bigint): string | undefined {
    return this.#roots.get(height.toString());
  }

  acceptedHeight(tokenId: TokenId): bigint {
    return this.#heights.get(tokenId.toString()) ?? 0n;
  }

  advanceHeight(tokenId: TokenId, height: bigint): void {
    const current = this.acceptedHeight(tokenId);
    if (height <= current) {
      throw new Error(`accepted height must advance: ${height} <= ${current}`);
    }
    this.#heights.set(tokenId.toString(), height);
  }
}
