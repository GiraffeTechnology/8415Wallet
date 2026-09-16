/**
 * Minimal ABI codec for the ERC-8415 read surface.
 *
 * Every argument and return value the wallet reads is a static type, including
 * both structs — `RegisterEntry` and `Settlement` are tuples of statics, so
 * they encode inline as consecutive words with no head/tail split. That keeps
 * this codec to fixed 32-byte words and no offset arithmetic.
 *
 * `finalizeSettlement` takes `bytes calldata proofData` and is therefore not
 * static. It is a write, and the wallet's read port does not carry it.
 */

import { ValueOutOfRangeError } from '../sdk/errors.ts';
import { selectorOf } from '../sdk/interfaceIds.ts';

export type StaticType = 'uint256' | 'uint64' | 'uint8' | 'address' | 'bool' | 'bytes32' | 'bytes4';

export type AbiValue = bigint | boolean | string;

const WORD_HEX = 64;

function stripPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function requireHex(value: string, bytes: number, what: string): string {
  const body = stripPrefix(value).toLowerCase();
  if (body.length !== bytes * 2 || !/^[0-9a-f]*$/.test(body)) {
    throw new ValueOutOfRangeError(`${what} (expected ${bytes} bytes, got ${value})`, 0n);
  }
  return body;
}

function encodeUint(value: bigint, bits: number, what: string): string {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new ValueOutOfRangeError(`${what} as uint${bits}`, value);
  }
  return value.toString(16).padStart(WORD_HEX, '0');
}

function encodeWord(type: StaticType, value: AbiValue): string {
  switch (type) {
    case 'uint256':
      return encodeUint(value as bigint, 256, 'value');
    case 'uint64':
      return encodeUint(value as bigint, 64, 'value');
    case 'uint8':
      return encodeUint(value as bigint, 8, 'value');
    case 'bool':
      return (value ? 1n : 0n).toString(16).padStart(WORD_HEX, '0');
    case 'address':
      return requireHex(value as string, 20, 'address').padStart(WORD_HEX, '0');
    case 'bytes32':
      return requireHex(value as string, 32, 'bytes32');
    case 'bytes4':
      // Short byte types are left-aligned, unlike numbers and addresses.
      return requireHex(value as string, 4, 'bytes4').padEnd(WORD_HEX, '0');
  }
}

function decodeWord(type: StaticType, word: string): AbiValue {
  switch (type) {
    case 'uint256':
    case 'uint64':
    case 'uint8':
      return BigInt(`0x${word}`);
    case 'bool':
      return BigInt(`0x${word}`) !== 0n;
    case 'address':
      return `0x${word.slice(24)}`;
    case 'bytes32':
      return `0x${word}`;
    case 'bytes4':
      return `0x${word.slice(0, 8)}`;
  }
}

/** Build `eth_call` data: four-byte selector followed by one word per argument. */
export function encodeCall(
  signature: string,
  argumentTypes: readonly StaticType[],
  args: readonly AbiValue[],
): string {
  if (argumentTypes.length !== args.length) {
    throw new ValueOutOfRangeError(
      `argument count for ${signature} (expected ${argumentTypes.length}, got ${args.length})`,
      0n,
    );
  }
  const words = argumentTypes.map((type, index) => encodeWord(type, args[index]!));
  return `${selectorOf(signature)}${words.join('')}`;
}

/** Encode static values as consecutive 32-byte words, with no selector. */
export function encodeWords(
  types: readonly StaticType[],
  values: readonly AbiValue[],
): string {
  return `0x${types.map((type, index) => encodeWord(type, values[index]!)).join('')}`;
}

/**
 * Decode a return payload of static types.
 *
 * A payload shorter than the declared types is rejected rather than
 * zero-filled: a truncated response must not become a plausible-looking answer.
 */
export function decodeResult(types: readonly StaticType[], data: string): AbiValue[] {
  const body = stripPrefix(data).toLowerCase();
  if (body.length < types.length * WORD_HEX) {
    throw new ValueOutOfRangeError(
      `return payload for ${types.length} word(s) (got ${body.length / 2} bytes)`,
      0n,
    );
  }
  return types.map((type, index) =>
    decodeWord(type, body.slice(index * WORD_HEX, (index + 1) * WORD_HEX)),
  );
}

/** Field order of `IRegisterProjection.RegisterEntry`. */
export const REGISTER_ENTRY_TYPES: readonly StaticType[] = [
  'bytes32', // recordCommitment
  'bytes32', // previousCommitment
  'bytes32', // registryReference
  'address', // holder
  'uint64', // version
  'uint64', // effectiveAt
  'uint64', // supersededAt
];

/** Field order of `IProjectionSettlement.Settlement`. */
export const SETTLEMENT_TYPES: readonly StaticType[] = [
  'uint256', // tokenId
  'address', // initiator
  'address', // expectedHolder
  'bytes32', // snapshotHash
  'uint64', // openedAt
  'uint64', // deadline
  'uint8', // status
];
