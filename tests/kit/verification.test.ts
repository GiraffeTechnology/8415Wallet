import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionStore } from '../../src/kit/engine/projection/store.ts';
import { ProofProfileRegistry } from '../../src/kit/engine/proof/profile.ts';
import { MerkleProofProfile, merklePath, merkleRoot } from '../../src/kit/engine/proof/merkleProfile.ts';
import { MockZkProofProfile } from '../../src/kit/engine/proof/zkProfile.ts';
import { bindingDigest, sha256Hex } from '../../src/kit/engine/proof/binding.ts';
import { MemoryChainAdapter } from '../../src/kit/adapters/memory/memoryChain.ts';
import { ZERO_BYTES32, type CandidateEntry } from '../../src/kit/engine/projection/types.ts';
import { ProjectionError } from '../../src/kit/engine/projection/errors.ts';
import { ALICE, BOB, REFERENCE, commitment, gap } from './support/fixtures.ts';

const TOKEN = 1n;
const HEIGHT = 42n;
const noise = (n: number) => `0x${n.toString(16).padStart(64, 'f')}`;

const candidate: CandidateEntry = {
  version: 1n,
  holder: ALICE,
  effectiveAt: 100n,
  recordCommitment: commitment(1),
  previousCommitment: ZERO_BYTES32,
  registryReference: REFERENCE,
};

/**
 * Build a store whose only profiles are the real ones, and publish a state
 * root at HEIGHT containing the binding digest for `entry`.
 */
const engine = (entry: CandidateEntry = candidate, settlementId = ZERO_BYTES32, profile = 'merkle') => {
  const adapter = new MemoryChainAdapter();
  const merkle = new MerkleProofProfile(adapter);
  const zk = new MockZkProofProfile(adapter);
  const profiles = new ProofProfileRegistry();
  profiles.register(merkle, sha256Hex(merkle.id));
  profiles.register(zk, sha256Hex(zk.id));
  const store = new ProjectionStore({
    registerId: commitment(0x8415),
    verificationProfile: sha256Hex(profile === 'zk' ? zk.id : merkle.id),
    profiles,
    adapter,
  });

  const binding = {
    chainId: adapter.chainId,
    contract: adapter.contract,
    tokenId: TOKEN,
    settlementId,
    snapshotHash: ZERO_BYTES32,
    holder: entry.holder,
    priorCommitment: entry.previousCommitment,
    nextCommitment: entry.recordCommitment,
    version: entry.version,
    effectiveAt: entry.effectiveAt,
  };
  const digest = bindingDigest(binding, entry);
  const leaves = [noise(1), digest, noise(2), noise(3)];
  adapter.setStateRoot(HEIGHT, merkleRoot(leaves));

  const context = { binding, candidate: entry, acceptedRemoteHeight: 0n, remoteFinalized: true };
  return { adapter, store, merkle, zk, digest, path: merklePath(leaves, 1), context };
};

const rejects = (code: string, run: () => unknown): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProjectionError);
    assert.equal(error.code, code);
    return true;
  });
};

test('a valid merkle inclusion proof admits', () => {
  const e = engine();
  const result = e.store.admit(TOKEN, candidate, {
    profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: e.path },
  });
  assert.equal(result.entry.holder, ALICE);
  assert.equal(e.store.entryCount(TOKEN), 1);
});

test('a merkle proof for a different admission does not verify', () => {
  const e = engine();
  // Same path, but the entry that gets submitted claims a different holder,
  // so the leaf recomputed from the binding no longer sits under the root.
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, { ...candidate, holder: BOB }, {
      profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: e.path },
    }));
  assert.equal(e.store.entryCount(TOKEN), 0);
});

test('every bound field changes the digest', () => {
  const e = engine();
  const base = bindingDigest(e.context.binding, candidate);

  const variants = [
    { ...e.context.binding, chainId: 999n },
    { ...e.context.binding, contract: `0x${'22'.repeat(20)}` },
    { ...e.context.binding, tokenId: 2n },
    { ...e.context.binding, settlementId: 'settlement:other' },
    { ...e.context.binding, snapshotHash: commitment(99) },
    { ...e.context.binding, holder: BOB },
    { ...e.context.binding, priorCommitment: commitment(9) },
    { ...e.context.binding, nextCommitment: commitment(9) },
    { ...e.context.binding, version: 2n },
    { ...e.context.binding, effectiveAt: 101n },
  ];
  for (const binding of variants) {
    assert.notEqual(bindingDigest(binding, candidate), base);
  }
  // And the entry's own registry reference is bound too.
  assert.notEqual(bindingDigest(e.context.binding, { ...candidate, registryReference: commitment(0xdead) }), base);
});

test('a tampered merkle path is refused', () => {
  const e = engine();
  const tampered = e.path.map((step) => ({ ...step, hash: noise(7) }));
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: tampered } }));

  // A flipped sibling side reorders the hash and fails the same way.
  const flipped = e.path.map((step) => ({ ...step, side: step.side === 'left' ? 'right' : 'left' }));
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: flipped } }));

  assert.equal(e.store.entryCount(TOKEN), 0);
});

test('a malformed proof payload is refused, not crashed on', () => {
  const e = engine();
  for (const payload of [{}, { path: 'nope' }, { path: [{ hash: 'short', side: 'left' }] }, { path: [{ hash: noise(1) }] }]) {
    rejects('PROOF_PROFILE_REJECTED', () =>
      e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload }));
  }
});

test('a proof against a height with no accepted root is refused', () => {
  const e = engine();
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: 41n, payload: { path: e.path } }));
});

test('the zk profile verifies a proof bound to this admission', () => {
  const e = engine(candidate, ZERO_BYTES32, 'zk');
  const proof = e.zk.prove({ remoteHeight: HEIGHT }, e.context);
  const result = e.store.admit(TOKEN, candidate, {
    profile: e.zk.id, remoteHeight: HEIGHT, payload: { proof },
  });
  assert.equal(result.entry.version, 1n);
});

test('a zk proof does not carry to another admission', () => {
  const e = engine(candidate, ZERO_BYTES32, 'zk');
  const proof = e.zk.prove({ remoteHeight: HEIGHT }, e.context);

  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, { ...candidate, effectiveAt: 101n }, {
      profile: e.zk.id, remoteHeight: HEIGHT, payload: { proof },
    }));
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(2n, candidate, { profile: e.zk.id, remoteHeight: HEIGHT, payload: { proof } }));
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, candidate, { profile: e.zk.id, remoteHeight: HEIGHT, payload: { proof: 'forged' } }));
});

test('a verified proof is not finality', () => {
  const e = engine();
  e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: e.path } });

  // The proof verified and the entry is in history. Nothing about that makes
  // the instant final: only a strictly later admitted entry does.
  assert.equal(e.store.holderAsOf(TOKEN, 100n), ALICE);
  assert.equal(e.store.isFinalAsOf(TOKEN, 100n), false);
});

test('the verification engine has no mutable asset state machine', () => {
  const e = engine();
  const surface = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(e.store)),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(e.merkle)),
  ];
  for (const forbidden of ['freeze', 'revoke', 'activate', 'settle', 'setState', 'transition', 'setFinal']) {
    assert.ok(!surface.includes(forbidden), `the engine exposes ${forbidden}`);
  }
  // No profile can report a verdict that means anything but "admitted or not".
  const verdict = e.merkle.verify({ profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: e.path } }, e.context);
  assert.deepEqual(Object.keys(verdict).sort(), ['admitted']);
});

test('an admission refused by the profile advances no remote height', () => {
  const e = engine();
  assert.equal(e.adapter.acceptedHeight(TOKEN), 0n);
  rejects('PROOF_PROFILE_REJECTED', () =>
    e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: [] } }));
  assert.equal(e.adapter.acceptedHeight(TOKEN), 0n);
  assert.equal(e.store.entryCount(TOKEN), 0);
});


test('the advertised identity selects a fixed registered verifier', () => {
  const profiles = new ProofProfileRegistry();
  const identity = commitment(123);
  let calls = 0;
  const profile = { id: 'configured', verify: () => { calls++; return { admitted: false as const, reason: 'policy' }; } };
  profiles.register(profile, identity);
  profiles.register({ id: 'other', verify: () => ({ admitted: true }) }, commitment(124));
  const store = new ProjectionStore({ registerId: commitment(1), verificationProfile: identity, profiles, adapter: new MemoryChainAdapter() });
  assert.throws(() => profiles.register(profile, identity), /already registered/);
  assert.throws(() => profiles.register(profile, commitment(125)), /already registered/);
  assert.throws(() => new ProjectionStore({ registerId: commitment(1), verificationProfile: commitment(999), profiles, adapter: new MemoryChainAdapter() }), /not registered/);
  rejects('PROOF_PROFILE_REJECTED', () => store.admit(TOKEN, candidate, { profile: 'other', remoteHeight: HEIGHT, payload: {} }));
  profile.verify = () => { throw new Error('replacement must not be called'); };
  rejects('PROOF_PROFILE_REJECTED', () => store.admit(TOKEN, candidate, { profile: 'configured', remoteHeight: HEIGHT, payload: {} }));
  assert.equal(calls, 1);
  assert.equal(store.entryCount(TOKEN), 0);
  assert.equal(store.verificationProfile, identity);
});


test('settlement admission uses the recorded snapshot in the binding', () => {
  const id = commitment(80);
  const snapshotHash = commitment(81);
  const e = engine(candidate, id);
  e.store.openGap(TOKEN, gap({ settlementId: id, snapshotHash, expectedHolder: ALICE }));
  const digest = bindingDigest({ ...e.context.binding, snapshotHash }, candidate);
  e.adapter.setStateRoot(HEIGHT, merkleRoot([digest]));
  const result = e.store.admit(TOKEN, candidate, { profile: e.merkle.id, remoteHeight: HEIGHT, payload: { path: [] } });
  assert.equal(result.gapClosed, true);
  assert.equal(e.store.settlement(id).snapshotHash, snapshotHash);
  assert.equal(e.store.settlement(id).status, 'ADMITTED');
});
