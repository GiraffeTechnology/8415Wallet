import { ProjectionStore } from '../../../src/kit/engine/projection/store.ts';
import { ProofProfileRegistry, admitted, refused, type ProofProfile } from '../../../src/kit/engine/proof/profile.ts';
import { MemoryChainAdapter } from '../../../src/kit/adapters/memory/memoryChain.ts';
import { ZERO_BYTES32, type Bytes32, type CandidateEntry, type Settlement } from '../../../src/kit/engine/projection/types.ts';

export const ALICE = '0x' + 'aa'.repeat(20);
export const BOB = '0x' + 'bb'.repeat(20);
export const CAROL = '0x' + 'cc'.repeat(20);

export const commitment = (n: number): Bytes32 => '0x' + n.toString(16).padStart(64, '0');
export const REFERENCE: Bytes32 = '0x' + 'ab'.repeat(32);

/** A full settlement record, so tests state only what they care about. */
export const gap = (over: Partial<Omit<Settlement, 'status' | 'tokenId'>> = {}): Omit<Settlement, 'status' | 'tokenId'> => ({
  settlementId: over.settlementId ?? commitment(0x51),
  initiator: over.initiator ?? ALICE,
  expectedHolder: over.expectedHolder ?? BOB,
  snapshotHash: over.snapshotHash ?? commitment(0x5a),
  openedAt: over.openedAt ?? 120n,
  deadline: over.deadline ?? 1_000n,
});

/**
 * A profile that admits anything. It exists so Stage 1 can exercise the
 * admission path before Stage 2 supplies real profiles; it is a test double,
 * never a default in the engine.
 */
export const openProfile: ProofProfile = {
  id: 'test:open',
  verify: () => admitted,
};

/** Refuses everything, to prove a refused proof admits nothing. */
export const closedProfile: ProofProfile = {
  id: 'test:closed',
  verify: () => refused('this profile refuses every proof'),
};

export interface Harness {
  readonly store: ProjectionStore;
  readonly adapter: MemoryChainAdapter;
  height: bigint;
}

export const harness = (): Harness => {
  const profiles = new ProofProfileRegistry();
  profiles.register(openProfile, commitment(0x0be7));
  profiles.register(closedProfile, commitment(0xc105));
  const adapter = new MemoryChainAdapter();
  const store = new ProjectionStore({
    registerId: commitment(0x8415),
    verificationProfile: commitment(0x0be7),
    profiles,
    adapter,
  });
  return { store, adapter, height: 0n };
};

export interface EntrySpec {
  readonly version: bigint;
  readonly holder: string;
  readonly effectiveAt: bigint;
  readonly recordCommitment: Bytes32;
  readonly previousCommitment?: Bytes32;
  readonly registryReference?: Bytes32;
}

export const entry = (spec: EntrySpec): CandidateEntry => ({
  version: spec.version,
  holder: spec.holder,
  effectiveAt: spec.effectiveAt,
  recordCommitment: spec.recordCommitment,
  previousCommitment: spec.previousCommitment ?? ZERO_BYTES32,
  registryReference: spec.registryReference ?? REFERENCE,
});

/** Admit a candidate, advancing the remote height so each proof is fresh. */
export const admit = (h: Harness, tokenId: bigint, candidate: CandidateEntry, profile = 'test:open') => {
  h.height += 1n;
  return h.store.admit(tokenId, candidate, { profile, remoteHeight: h.height, payload: {} });
};
