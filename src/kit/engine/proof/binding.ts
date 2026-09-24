import { createHash } from 'node:crypto';
import type { AdmissionBinding } from './profile.ts';
import type { CandidateEntry } from '../projection/types.ts';

const sha256 = (input: Buffer | string): Buffer => createHash('sha256').update(input).digest();

/**
 * Canonical digest of what a proof is allowed to admit.
 *
 * Every field is length-prefixed before joining, so no two different bindings
 * can encode to the same string by moving a delimiter across a field
 * boundary. A proof produced for one chain, contract, token, settlement,
 * holder, commitment pair, version or effective time therefore cannot be
 * replayed against another.
 */
export const bindingDigest = (binding: AdmissionBinding, candidate: CandidateEntry): string => {
  const fields = [
    'erc8415/admission/v2',
    binding.chainId.toString(),
    binding.contract.toLowerCase(),
    binding.tokenId.toString(),
    binding.settlementId.toLowerCase(),
    binding.snapshotHash.toLowerCase(),
    binding.holder.toLowerCase(),
    binding.priorCommitment.toLowerCase(),
    binding.nextCommitment.toLowerCase(),
    binding.version.toString(),
    binding.effectiveAt.toString(),
    candidate.registryReference,
  ];
  const encoded = fields.map((field) => `${field.length}:${field}`).join('|');
  return `0x${sha256(encoded).toString('hex')}`;
};

export const hashPair = (left: string, right: string): string => {
  const bytes = Buffer.concat([hexToBytes(left), hexToBytes(right)]);
  return `0x${sha256(bytes).toString('hex')}`;
};

export const hexToBytes = (hex: string): Buffer => Buffer.from(hex.replace(/^0x/, ''), 'hex');

export const sha256Hex = (input: string): string => `0x${sha256(input).toString('hex')}`;
