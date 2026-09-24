import { bindingDigest, hashPair } from './binding.ts';
import { admitted, refused, type ProofContext, type ProofMaterial, type ProofProfile, type ProofVerdict } from './profile.ts';
import type { RemoteChainAdapter } from '../ports.ts';

export interface MerkleStep {
  readonly hash: string;
  readonly side: 'left' | 'right';
}

const HASH = /^0x[0-9a-f]{64}$/;

const isStep = (value: unknown): value is MerkleStep => {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as { hash?: unknown; side?: unknown };
  return typeof step.hash === 'string' && HASH.test(step.hash) && (step.side === 'left' || step.side === 'right');
};

/**
 * Merkle inclusion against the remote state root the adapter reports for the
 * claimed height.
 *
 * The leaf is the admission binding digest, not the entry alone: inclusion of
 * some record somewhere proves nothing unless the record is bound to this
 * chain, contract, token, settlement, holder, commitment pair, version and
 * effective time.
 *
 * What a passing proof establishes is inclusion in accepted remote state. It
 * is not the truth of the underlying register, and it is not finality — the
 * entry enters history, and whether any instant is final follows from the
 * later-admission rule afterwards.
 */
export class MerkleProofProfile implements ProofProfile {
  readonly id = 'merkle/sha256/v1';
  readonly #adapter: RemoteChainAdapter;

  constructor(adapter: RemoteChainAdapter) {
    this.#adapter = adapter;
  }

  verify(material: ProofMaterial, context: ProofContext): ProofVerdict {
    const root = this.#adapter.stateRootAt(material.remoteHeight);
    if (root === undefined) {
      return refused(`no accepted state root at remote height ${material.remoteHeight}`);
    }

    const path = material.payload['path'];
    if (!Array.isArray(path) || !path.every(isStep)) {
      return refused('proof payload has no well-formed merkle path');
    }
    if (path.length > 64) {
      return refused('merkle path is longer than the profile allows');
    }

    let node = bindingDigest(context.binding, context.candidate);
    for (const step of path) {
      node = step.side === 'left' ? hashPair(step.hash, node) : hashPair(node, step.hash);
    }

    if (node !== root) {
      return refused('the binding digest is not included in the accepted remote state');
    }
    return admitted;
  }
}

/** Build a path for a leaf in a fixed list. Used to produce test vectors. */
export const merklePath = (leaves: readonly string[], index: number): MerkleStep[] => {
  if (index < 0 || index >= leaves.length) throw new RangeError('leaf index out of range');
  const path: MerkleStep[] = [];
  let level = [...leaves];
  let position = index;

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1] ?? left;
      if (i === position - (position % 2)) {
        path.push(position % 2 === 0 ? { hash: right, side: 'right' } : { hash: left, side: 'left' });
      }
      next.push(hashPair(left, right));
    }
    level = next;
    position = position >> 1;
  }
  return path;
};

export const merkleRoot = (leaves: readonly string[]): string => {
  if (leaves.length === 0) throw new RangeError('cannot root an empty tree');
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      next.push(hashPair(left, level[i + 1] ?? left));
    }
    level = next;
  }
  return level[0] as string;
};
