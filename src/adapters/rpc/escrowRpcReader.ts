import { decodeResult, encodeCall } from '../../codec/abi.ts';
import type { AbiValue, StaticType } from '../../codec/abi.ts';
import { NoContractAtAddressError, ValueOutOfRangeError } from '../../sdk/errors.ts';
import {
  TRADE_STATE_BY_INDEX,
  type EscrowReader,
  type Trade,
  type TradeObservation,
  type TradeState,
} from '../../sdk/escrow.ts';
import type { Address, Bytes32 } from '../../sdk/types.ts';
import type { CallTransport } from './transport.ts';

/**
 * Reads a `ProjectionEscrow` over `eth_call`.
 *
 * A struct of static fields ABI-encodes flat, so `tradeOf` decodes in field
 * order with no offsets involved. This adapter computes nothing.
 */
const TRADE_TYPES: readonly StaticType[] = [
  'address', // projection
  'uint256', // tokenId
  'address', // seller
  'address', // buyer
  'uint256', // price
  'uint64', // entryCountAtFunding
  'uint64', // admissionDeadline
  'uint64', // maxEffectiveAt
  'uint8', // state
];

const OBSERVATION_TYPES: readonly StaticType[] = [
  'uint8', // state
  'bool', // confirmed
  'uint64', // version
  'uint64', // effectiveAt
  'address', // confirmedHolder
  'address', // positionHolder
  'uint64', // entryCount
];

export class RpcEscrowReader implements EscrowReader {
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
    const data = encodeCall(signature, ['bytes32'], args);
    const result = await this.#transport.call(this.source.address, data);
    if (result === '0x' || result === '') {
      throw new NoContractAtAddressError(this.source.address, signature);
    }
    return decodeResult(returnTypes, result);
  }

  async tradeOf(tradeKey: Bytes32): Promise<Trade> {
    const f = await this.#read('tradeOf(bytes32)', [tradeKey], TRADE_TYPES);
    return {
      projection: f[0] as Address,
      tokenId: f[1] as bigint,
      seller: f[2] as Address,
      buyer: f[3] as Address,
      price: f[4] as bigint,
      entryCountAtFunding: f[5] as bigint,
      admissionDeadline: f[6] as bigint,
      maxEffectiveAt: f[7] as bigint,
      state: toTradeState(f[8] as bigint),
    };
  }

  async observe(tradeKey: Bytes32): Promise<TradeObservation> {
    const f = await this.#read('observe(bytes32)', [tradeKey], OBSERVATION_TYPES);
    return {
      state: toTradeState(f[0] as bigint),
      confirmed: f[1] as boolean,
      version: f[2] as bigint,
      effectiveAt: f[3] as bigint,
      confirmedHolder: f[4] as Address,
      positionHolder: f[5] as Address,
      entryCount: f[6] as bigint,
    };
  }
}

/**
 * Map the on-chain enum ordinal.
 *
 * An unmapped ordinal throws rather than falling back to a neighbouring state,
 * for the same reason the settlement status does: a state the wallet does not
 * understand must not be rendered as one it does.
 */
function toTradeState(ordinal: bigint): TradeState {
  const state = TRADE_STATE_BY_INDEX[Number(ordinal)];
  if (state === undefined) throw new ValueOutOfRangeError('trade state ordinal', ordinal);
  return state;
}
