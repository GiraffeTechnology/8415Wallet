import { keccak256Utf8 } from '../codec/keccak.ts';

/** Human/agent input only. Preserve unchecksummed lower/upper-case addresses,
 * but validate ERC-55 mixed case before any normalization loses the checksum.
 * RPC addresses remain byte values and do not use this input policy. */
export function isAddressInput(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 42 || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0+$/.test(value)) return false;
  const body = value.slice(2), lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true;
  const hash = keccak256Utf8(lower).slice(2);
  return [...lower].every((character, i) =>
    body[i] === (parseInt(hash[i]!, 16) >= 8 ? character.toUpperCase() : character));
}
