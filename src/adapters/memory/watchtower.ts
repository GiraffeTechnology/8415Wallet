import { keccak256 } from '../../codec/keccak.ts';
import { ContractRevertError } from '../../sdk/errors.ts';
import type {
  Freshness,
  FreshnessAnswer,
  WatchtowerHead,
  WatchtowerPolicy,
  WatchtowerReader,
} from '../../sdk/watchtower.ts';
import type { Address, Bytes32 } from '../../sdk/types.ts';

/**
 * In-memory watchtower, implementing the classification rule as published.
 *
 * With `age = block.number - head.signedAtBlock`:
 *
 *   no head, or asset unregistered  -> UNKNOWN
 *   head's key revoked              -> STALE
 *   age > head.freshnessThreshold   -> STALE
 *   age >= finalityDepth            -> FRESH_FINAL
 *   otherwise                       -> FRESH_PENDING
 *
 * A `finalityDepth` of zero makes every fresh head `FRESH_FINAL`, which suits
 * single-slot finality chains.
 */
/** This model's hashing namespace. A real deployment declares its own. */
const MEMORY_NAMESPACE: string = `0x${'11'.repeat(32)}`;

export class MemoryWatchtowerContract {
  readonly chainId: bigint;
  readonly address: Address;

  #blockNumber: bigint;
  readonly #policies = new Map<Bytes32, WatchtowerPolicy>();
  readonly #heads = new Map<Bytes32, WatchtowerHead>();
  readonly #revokedKeys = new Map<Bytes32, Set<Address>>();

  constructor(options: { chainId?: bigint; address?: Address; blockNumber?: bigint } = {}) {
    this.chainId = options.chainId ?? 1n;
    this.address = options.address ?? '0x77a7c4000000000000000000000000000000000f';
    this.#blockNumber = options.blockNumber ?? 1_000n;
  }

  get blockNumber(): bigint {
    return this.#blockNumber;
  }

  advanceBlocks(count: bigint): void {
    this.#blockNumber += count;
  }

  registerAsset(
    assetId: Bytes32,
    policy: { steward: Address; finalityDepth: bigint; maxFreshnessThreshold: bigint },
  ): void {
    this.#policies.set(assetId, {
      steward: policy.steward,
      finalityDepth: policy.finalityDepth,
      maxFreshnessThreshold: policy.maxFreshnessThreshold,
      pendingSteward: `0x${'0'.repeat(40)}`,
      registered: true,
    });
  }

  /** Record an accepted attestation as the new head. */
  submit(
    assetId: Bytes32,
    head: { signedAtBlock: bigint; sequenceNumber: bigint; freshnessThreshold: bigint; key: Address },
  ): void {
    const policy = this.#policies.get(assetId);
    if (policy === undefined) throw new ContractRevertError(`submit: asset not registered`);
    if (head.freshnessThreshold === 0n || head.freshnessThreshold > policy.maxFreshnessThreshold) {
      throw new ContractRevertError('submit: freshnessThreshold out of range');
    }
    if (this.#blockNumber - head.signedAtBlock > head.freshnessThreshold) {
      throw new ContractRevertError('submit: attestation already stale');
    }
    this.#heads.set(assetId, { ...head, recordedAtBlock: this.#blockNumber });
  }

  /** Revocation means compromise: the head's classification collapses to STALE. */
  revokeKey(assetId: Bytes32, key: Address): void {
    const revoked = this.#revokedKeys.get(assetId) ?? new Set<Address>();
    revoked.add(key);
    this.#revokedKeys.set(assetId, revoked);
  }

  freshnessOf(assetId: Bytes32): FreshnessAnswer {
    const policy = this.#policies.get(assetId);
    const head = this.#heads.get(assetId);
    if (policy === undefined || !policy.registered || head === undefined) {
      return { status: 'UNKNOWN', age: 0n };
    }

    const age = this.#blockNumber - head.signedAtBlock;
    const status: Freshness = this.#revokedKeys.get(assetId)?.has(head.key)
      ? 'STALE'
      : age > head.freshnessThreshold
        ? 'STALE'
        : age >= policy.finalityDepth
          ? 'FRESH_FINAL'
          : 'FRESH_PENDING';
    return { status, age };
  }

  headOf(assetId: Bytes32): WatchtowerHead {
    const head = this.#heads.get(assetId);
    if (head === undefined) throw new ContractRevertError('headOf: no head recorded');
    return head;
  }

  /**
   * `keccak256(namespace, registrar, salt)`.
   *
   * The namespace here is this model's own. A deployment's differs, which is
   * exactly why the wallet asks the contract instead of computing it.
   */
  computeAssetId(registrar: Address, salt: Bytes32): Bytes32 {
    const packed =
      MEMORY_NAMESPACE.slice(2) + registrar.slice(2).padStart(64, '0') + salt.slice(2);
    return `0x${Buffer.from(keccak256(Buffer.from(packed, 'hex'))).toString('hex')}`;
  }

  policyOf(assetId: Bytes32): WatchtowerPolicy {
    const policy = this.#policies.get(assetId);
    if (policy === undefined) throw new ContractRevertError('policyOf: asset not registered');
    return policy;
  }
}

/** Binds the modelled watchtower to the watchtower port. */
export class MemoryWatchtowerReader implements WatchtowerReader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #contract: MemoryWatchtowerContract;

  constructor(contract: MemoryWatchtowerContract) {
    this.#contract = contract;
    this.source = { chainId: contract.chainId, address: contract.address };
  }

  async freshnessOf(assetId: Bytes32): Promise<FreshnessAnswer> {
    return this.#contract.freshnessOf(assetId);
  }

  async headOf(assetId: Bytes32): Promise<WatchtowerHead> {
    return this.#contract.headOf(assetId);
  }

  async policyOf(assetId: Bytes32): Promise<WatchtowerPolicy> {
    return this.#contract.policyOf(assetId);
  }

  async computeAssetId(registrar: Address, salt: Bytes32): Promise<Bytes32> {
    return this.#contract.computeAssetId(registrar, salt);
  }
}
