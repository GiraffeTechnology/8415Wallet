import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Ed25519AttestationProfile, MAX_ATTESTATION_WINDOW } from '../../src/kit/engine/proof/attestationProfile.ts';
import { ProjectionStore } from '../../src/kit/engine/projection/store.ts';
import { ProofProfileRegistry } from '../../src/kit/engine/proof/profile.ts';
import { MemoryChainAdapter } from '../../src/kit/adapters/memory/memoryChain.ts';
import { ProjectionError } from '../../src/kit/engine/projection/errors.ts';
import { ZERO_BYTES32, type CandidateEntry, type Instant } from '../../src/kit/engine/projection/types.ts';
import { ALICE, BOB, REFERENCE, commitment } from './support/fixtures.ts';

const TOKEN = 1n;
const HEIGHT = 42n;

const candidate: CandidateEntry = {
  version: 1n, holder: ALICE, effectiveAt: 100n,
  recordCommitment: commitment(1), previousCommitment: ZERO_BYTES32, registryReference: REFERENCE,
};

class TestClock {
  #now: Instant;
  constructor(now: Instant) { this.#now = now; }
  now(): Instant { return this.#now; }
  advance(by: Instant): void { this.#now += by; }
}

const scene = () => {
  const registrar = generateKeyPairSync('ed25519');
  const impostor = generateKeyPairSync('ed25519');
  const rawPublic = Buffer.from(registrar.publicKey.export({ type: 'spki', format: 'der' })).subarray(12);

  const clock = new TestClock(1_000n);
  const adapter = new MemoryChainAdapter();
  const profile = new Ed25519AttestationProfile({
    trustedIssuers: { 'landreg.example': rawPublic.toString('base64') },
    clock,
  });
  const profiles = new ProofProfileRegistry();
  profiles.register(profile, commitment(0x0be7));
  const store = new ProjectionStore({
    registerId: commitment(0x8415), verificationProfile: commitment(0x0be7), profiles, adapter,
  });

  const context = {
    binding: {
      chainId: adapter.chainId, contract: adapter.contract, tokenId: TOKEN,
      settlementId: ZERO_BYTES32, snapshotHash: ZERO_BYTES32, holder: candidate.holder,
      priorCommitment: candidate.previousCommitment, nextCommitment: candidate.recordCommitment,
      version: candidate.version, effectiveAt: candidate.effectiveAt,
    },
    candidate,
    acceptedRemoteHeight: 0n,
    remoteFinalized: true,
  };

  const attest = (expiresAt: Instant, key = registrar.privateKey, issuer = 'landreg.example') => ({
    issuer,
    expiresAt: expiresAt.toString(),
    signature: sign(null, profile.message(context, expiresAt, issuer), key).toString('base64'),
  });

  return { store, profile, clock, context, attest, impostor };
};

const rejects = (run: () => unknown): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProjectionError);
    assert.equal(error.code, 'PROOF_PROFILE_REJECTED');
    return true;
  });
};

test('a trusted issuer attestation admits', () => {
  const s = scene();
  const result = s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload: s.attest(2_000n),
  });
  assert.equal(result.entry.holder, ALICE);
});

test('an untrusted issuer is refused even with a valid signature', () => {
  const s = scene();
  rejects(() => s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT,
    payload: s.attest(2_000n, s.impostor.privateKey, 'landreg.example'),
  }));
  rejects(() => s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT,
    payload: { ...s.attest(2_000n), issuer: 'someone.else' },
  }));
  assert.equal(s.store.entryCount(TOKEN), 0);
});

test('the window is bounded on both sides', () => {
  const s = scene();
  // Already expired.
  rejects(() => s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload: s.attest(1_000n),
  }));
  // Valid for longer than the profile allows: a standing permission nobody reviews.
  rejects(() => s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT,
    payload: s.attest(1_000n + MAX_ATTESTATION_WINDOW + 1n),
  }));

  const ok = s.attest(1_000n + MAX_ATTESTATION_WINDOW);
  assert.equal(s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload: ok,
  }).entry.version, 1n);
});

test('an attestation that has aged past its expiry stops verifying', () => {
  const s = scene();
  const payload = s.attest(1_500n);
  s.clock.advance(600n);
  rejects(() => s.store.admit(TOKEN, candidate, { profile: s.profile.id, remoteHeight: HEIGHT, payload }));
});

test('an attestation does not carry to another admission', () => {
  const s = scene();
  const payload = s.attest(2_000n);

  // Another token, and a different effective time: both change the binding.
  rejects(() => s.store.admit(2n, candidate, { profile: s.profile.id, remoteHeight: HEIGHT, payload }));
  rejects(() => s.store.admit(TOKEN, { ...candidate, effectiveAt: 101n }, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload,
  }));
  rejects(() => s.store.admit(TOKEN, { ...candidate, holder: BOB }, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload,
  }));
});

test('a malformed attestation payload is refused, not fatal', () => {
  const s = scene();
  for (const payload of [
    {},
    { issuer: 'landreg.example' },
    { ...s.attest(2_000n), signature: 'not base64 !!' },
    { ...s.attest(2_000n), signature: Buffer.alloc(63).toString('base64') },
    { ...s.attest(2_000n), expiresAt: 'soon' },
  ]) {
    rejects(() => s.store.admit(TOKEN, candidate, { profile: s.profile.id, remoteHeight: HEIGHT, payload }));
  }
  assert.equal(s.store.entryCount(TOKEN), 0);
});

test('a verified attestation is still not finality', () => {
  const s = scene();
  s.store.admit(TOKEN, candidate, {
    profile: s.profile.id, remoteHeight: HEIGHT, payload: s.attest(2_000n),
  });

  // A trusted registrar signed it, inside the window, and the instant remains
  // provisional. Only a strictly later admitted entry changes that.
  assert.equal(s.store.holderAsOf(TOKEN, 100n), ALICE);
  assert.equal(s.store.isFinalAsOf(TOKEN, 100n), false);
});
