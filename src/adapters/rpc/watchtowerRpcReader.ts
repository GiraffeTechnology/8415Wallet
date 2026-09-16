import { decodeResult, encodeCall, type AbiValue, type StaticType } from '../../codec/abi.ts';
import { ValueOutOfRangeError } from '../../sdk/errors.ts';
import type { Address, Bytes32 } from '../../sdk/types.ts';
import {
  FRESHNESS_BY_INDEX,
  type Freshness,
  type FreshnessAnswer,
  type WatchtowerHead,
  type WatchtowerPolicy,
  type WatchtowerReader,
} from '../../sdk/watchtower.ts';
import type { CallTransport } from './transport.ts';

/** Field order of `IWatchtowerFreshnessLayer.Head`. */
const HEAD_TYPES: readonly StaticType[] = [
  'uint64', // signedAtBlock
  'uint64', // sequenceNumber
  'uint64', // freshnessThreshold
  'uint64', // recordedAtBlock
  'address', // key
];

/** Field order of `IWatchtowerFreshnessLayer.AssetPolicy`. */
const POLICY_TYPES: readonly StaticType[] = [
  'address', // steward
  'uint64', // finalityDepth
  'uint64', // maxFreshnessThreshold
  'address', // pendingSteward
  'bool', // registered
];

/** Reads a watchtower freshness layer over `eth_call`. */
export class RpcWatchtowerReader implements WatchtowerReader {
  readonly source: { readonly chainId: bigint; readonly address: Address };
  readonly #transport: CallTransport;

  constructor(transport: CallTransport, chainId: bigint, address: Address) {
    this.#transport = transport;
    this.source = { chainId, address };
  }

  async #read(
    signature: string,
    args: readonly AbiValue[],
    returnTypes: readonly StaticType[],
  ): Promise<AbiValue[]> {
    const data = encodeCall(signature, args.length === 0 ? [] : ['bytes32'], args);
    return decodeResult(returnTypes, await this.#transport.call(this.source.address, data));
  }

  async freshnessOf(assetId: Bytes32): Promise<FreshnessAnswer> {
    const [status, age] = await this.#read(
      'freshnessOf(bytes32)',
      [assetId],
      ['uint8', 'uint256'],
    );
    return { status: toFreshness(status as bigint), age: age as bigint };
  }

  async headOf(assetId: Bytes32): Promise<WatchtowerHead> {
    const fields = await this.#read('headOf(bytes32)', [assetId], HEAD_TYPES);
    return {
      signedAtBlock: fields[0] as bigint,
      sequenceNumber: fields[1] as bigint,
      freshnessThreshold: fields[2] as bigint,
      recordedAtBlock: fields[3] as bigint,
      key: fields[4] as Address,
    };
  }

  async computeAssetId(registrar: Address, salt: Bytes32): Promise<Bytes32> {
    const data = encodeCall(
      'computeAssetId(address,bytes32)',
      ['address', 'bytes32'],
      [registrar, salt],
    );
    const [assetId] = decodeResult(['bytes32'], await this.#transport.call(this.source.address, data));
    return assetId as Bytes32;
  }

  async policyOf(assetId: Bytes32): Promise<WatchtowerPolicy> {
    const fields = await this.#read('policyOf(bytes32)', [assetId], POLICY_TYPES);
    return {
      steward: fields[0] as Address,
      finalityDepth: fields[1] as bigint,
      maxFreshnessThreshold: fields[2] as bigint,
      pendingSteward: fields[3] as Address,
      registered: fields[4] as boolean,
    };
  }
}

/** An unmapped ordinal throws rather than falling back to a neighbouring state. */
function toFreshness(ordinal: bigint): Freshness {
  const status = FRESHNESS_BY_INDEX[Number(ordinal)];
  if (status === undefined) {
    throw new ValueOutOfRangeError('freshness ordinal', ordinal);
  }
  return status;
}
