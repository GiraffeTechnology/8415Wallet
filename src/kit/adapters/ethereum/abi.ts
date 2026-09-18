import type { Address, Bytes32, ProjectionEntry } from '../../engine/projection/types.ts';

/**
 * Function selectors for the frozen interfaces, written as constants so the
 * adapter needs no hashing library at runtime. `contracts.test.ts` recomputes
 * every one of them from the compiled ABI, so a drifted signature fails the
 * suite rather than producing a call nobody notices is wrong.
 */
export const SELECTOR = {
  currentEntry: '0xab041ef4',
  entryAt: '0xf6752412',
  entryAsOf: '0x7fc43f3a',
  holderAsOf: '0x013c5d9c',
  isFinalAsOf: '0xe6591ac9',
  entryCount: '0x1d1b039c',
  registerId: '0xbbc2a065',
  openGapOf: '0x819dc64f',
  verificationProfile: '0x43396e0a',
  settlementPeriod: '0x0f1071be',
  isSettlementAuthority: '0xdb966382',
  supportsInterface: '0x01ffc9a7',
} as const;

const strip = (hex: string): string => hex.replace(/^0x/, '');

export const word = (value: bigint | string): string => {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError('cannot encode a negative value');
    return value.toString(16).padStart(64, '0');
  }
  const bare = strip(value).toLowerCase();
  if (bare.length > 64) throw new RangeError('value is wider than one word');
  return bare.padStart(64, '0');
};

export const encodeCall = (selector: string, args: readonly (bigint | string)[]): string =>
  `${selector}${args.map(word).join('')}`;

/** Split a returndata blob into 32-byte words. */
export const words = (data: string): string[] => {
  const bare = strip(data);
  if (bare.length % 64 !== 0) throw new Error('returndata is not a whole number of words');
  const out: string[] = [];
  for (let i = 0; i < bare.length; i += 64) out.push(bare.slice(i, i + 64));
  return out;
};

export const toBigInt = (slot: string): bigint => BigInt(`0x${slot}`);
export const toBytes32 = (slot: string): Bytes32 => `0x${slot}`;
export const toAddress = (slot: string): Address => `0x${slot.slice(24)}`;
export const toBool = (slot: string): boolean => toBigInt(slot) !== 0n;

/**
 * `RegisterEntry` is seven static words, so it decodes in field order with no
 * offsets involved.
 */
export const decodeEntry = (data: string): ProjectionEntry => {
  const slots = words(data);
  if (slots.length < 7) throw new Error(`expected 7 words of entry, got ${slots.length}`);
  return {
    recordCommitment: toBytes32(slots[0] as string),
    previousCommitment: toBytes32(slots[1] as string),
    registryReference: toBytes32(slots[2] as string),
    holder: toAddress(slots[3] as string),
    version: toBigInt(slots[4] as string),
    effectiveAt: toBigInt(slots[5] as string),
    supersededAt: toBigInt(slots[6] as string),
  };
};
