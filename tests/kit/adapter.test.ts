import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Utf8 } from '../../src/codec/keccak.ts';
import { EthereumProjectionReader } from '../../src/kit/adapters/ethereum/projectionReader.ts';
import { ProjectionStore } from '../../src/kit/engine/projection/store.ts';
import { ProofProfileRegistry } from '../../src/kit/engine/proof/profile.ts';
import { MerkleProofProfile } from '../../src/kit/engine/proof/merkleProfile.ts';
import { bindingDigest, sha256Hex } from '../../src/kit/engine/proof/binding.ts';
import { EthereumChainAdapter } from '../../src/kit/adapters/ethereum/ethereumChain.ts';
import { SELECTOR, decodeEntry, encodeCall, words } from '../../src/kit/adapters/ethereum/abi.ts';
import { FakeNode } from './support/fakeNode.ts';
import { ALICE, BOB, REFERENCE, commitment } from './support/fixtures.ts';
import { ZERO_BYTES32, type ProjectionEntry } from '../../src/kit/engine/projection/types.ts';
import { compileContracts, abiOf } from './support/solc.ts';

// The wallet's own Keccak-256, in place of the dependency the Kit used before
// the merge. Same reason as in contracts.test.ts: the selectors these tests
// check are then derived by this repository rather than handed to it.

const CONTRACT = `0x${'ee'.repeat(20)}`;

const entries: ProjectionEntry[] = [
  {
    recordCommitment: commitment(1), previousCommitment: ZERO_BYTES32, registryReference: REFERENCE,
    holder: ALICE, version: 1n, effectiveAt: 100n, supersededAt: 130n,
  },
  {
    recordCommitment: commitment(2), previousCommitment: commitment(1), registryReference: REFERENCE,
    holder: BOB, version: 2n, effectiveAt: 130n, supersededAt: 0n,
  },
];

const node = () => new FakeNode({
  registerId: commitment(0x8415),
  entries,
  openGap: ZERO_BYTES32,
  supports: ['0x6309e170'],
  applicationRoot: commitment(0x777),
  finalized: { number: 0x1234n, stateRoot: `0x${'ab'.repeat(32)}` },
});

const applicationRoot = { contract: `0x${'dd'.repeat(20)}`, callData: '0x12345678' };

const reader = (transport: FakeNode) => new EthereumProjectionReader({ transport, contract: CONTRACT });

test('the hardcoded selectors match the compiled ABI', () => {
  // The adapter carries selectors as constants so it needs no hashing library
  // at runtime. This is what stops one silently drifting from the interface.
  const output = compileContracts();
  const selector = (sig: string) => keccak256Utf8(sig).slice(0, 10);

  const signatures = new Map<string, string>();
  for (const [file, name] of [
    ['IRegisterProjection.sol', 'IRegisterProjection'],
    ['IProjectionSettlement.sol', 'IProjectionSettlement'],
  ] as const) {
    for (const item of abiOf(output, file, name) as { type: string; name?: string; inputs?: { type: string }[] }[]) {
      if (item.type !== 'function' || item.name === undefined) continue;
      signatures.set(item.name, `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(',')})`);
    }
  }

  for (const [name, expected] of Object.entries(SELECTOR)) {
    const signature = signatures.get(name);
    assert.ok(signature !== undefined, `no ABI entry for ${name}`);
    assert.equal(expected, selector(signature), `selector for ${name} has drifted`);
  }
});

test('conformance is discovered, never assumed', async () => {
  const transport = node();
  const r = reader(transport);
  assert.equal(await r.supportsProjection(), true);
  // The contract advertises projection but not settlement: it has no gaps.
  // That is a property of the contract, not a failure.
  assert.equal(await r.supportsSettlement(), false);

  transport.set({ supports: [] });
  assert.equal(await r.supportsProjection(), false);
});

test('the reader decodes every projection accessor', async () => {
  const r = reader(node());
  assert.equal(await r.registerId(), commitment(0x8415));
  assert.equal(await r.entryCount(1n), 2n);
  assert.equal(await r.holderAsOf(1n, 120n), ALICE);
  assert.equal(await r.holderAsOf(1n, 130n), BOB);
  assert.equal(await r.isFinalAsOf(1n, 120n), true);
  assert.equal(await r.isFinalAsOf(1n, 130n), false);
  assert.equal(await r.openGapOf(1n), ZERO_BYTES32);

  const current = await r.currentEntry(1n);
  assert.equal(current.holder, BOB);
  assert.equal(current.supersededAt, 0n);

  const first = await r.entryAt(1n, 1n);
  assert.equal(first.holder, ALICE);
  assert.equal(first.supersededAt, 130n);
  assert.equal(first.registryReference, REFERENCE);

  const asOf = await r.entryAsOf(1n, 129n);
  assert.equal(asOf.version, 1n);
});

test('a revert surfaces rather than becoming a fallback answer', async () => {
  const r = reader(node());
  await assert.rejects(() => r.holderAsOf(1n, 99n), /instant not covered/);
  await assert.rejects(() => r.entryAt(1n, 9n), /unknown version/);
});

test('reads are pinned to the finalized head by default', async () => {
  const transport = node();
  await reader(transport).holderAsOf(1n, 120n);
  const call = transport.calls.find((c) => c.method === 'eth_call');
  assert.equal(call?.params[1], 'finalized');

  const pinned = new EthereumProjectionReader({ transport, contract: CONTRACT, block: '0x10' });
  await pinned.holderAsOf(1n, 120n);
  assert.equal(transport.calls.at(-1)?.params[1], '0x10');
});

test('calldata encodes as the interface expects', () => {
  const data = encodeCall(SELECTOR.holderAsOf, [1n, 120n]);
  assert.equal(data.slice(0, 10), SELECTOR.holderAsOf);
  assert.deepEqual(words(`0x${data.slice(10)}`).map((w) => BigInt(`0x${w}`)), [1n, 120n]);
});

test('a truncated entry blob is refused, not silently padded', () => {
  assert.throws(() => decodeEntry(`0x${'00'.repeat(32 * 6)}`), /expected 7 words/);
  assert.throws(() => decodeEntry('0xabc'), /whole number of words/);
});

test('the chain adapter reads an application root at the finalized block hash', async () => {
  const transport = node();
  const chain = new EthereumChainAdapter({ transport, chainId: 1n, contract: CONTRACT, applicationRoot });

  assert.equal(chain.isFinalized(1n), false);
  const height = await chain.refresh();
  assert.equal(height, 0x1234n);
  assert.equal(chain.isFinalized(0x1234n), true);
  assert.equal(chain.isFinalized(0x1235n), false);
  assert.equal(chain.stateRootAt(0x1234n), commitment(0x777));
  assert.deepEqual(transport.calls.at(-1)?.params, [
    { to: applicationRoot.contract, data: applicationRoot.callData },
    { blockHash: commitment(0x1234), requireCanonical: true },
  ]);
  assert.equal(chain.stateRootAt(0x1230n), undefined);
});

test('a finalized head that moves backwards is refused', async () => {
  const transport = node();
  const chain = new EthereumChainAdapter({ transport, chainId: 1n, contract: CONTRACT, applicationRoot });
  await chain.refresh();
  transport.set({ finalized: { number: 0x1000n, stateRoot: `0x${'cd'.repeat(32)}` } });
  await assert.rejects(() => chain.refresh(), /moved backwards/);
  assert.equal(chain.finalizedHeight, 0x1234n);
});

test('chain finality is not projection finality', async () => {
  const transport = node();
  const chain = new EthereumChainAdapter({ transport, chainId: 1n, contract: CONTRACT, applicationRoot });
  await chain.refresh();

  // The head is deeply finalized, and the latest interval is still not final:
  // only a strictly later admitted entry does that. Block depth never does.
  assert.equal(chain.isFinalized(0x1234n), true);
  assert.equal(await reader(transport).isFinalAsOf(1n, 200n), false);
});

test('an accepted height never goes backwards', () => {
  const chain = new EthereumChainAdapter({ transport: node(), chainId: 1n, contract: CONTRACT, applicationRoot });
  chain.advanceHeight(1n, 10n);
  assert.throws(() => chain.advanceHeight(1n, 10n), /must advance/);
  assert.throws(() => chain.advanceHeight(1n, 9n), /must advance/);
  assert.equal(chain.acceptedHeight(1n), 10n);
});


test('the Ethereum application root supports a normal Merkle admission', async () => {
  const transport = node();
  const chain = new EthereumChainAdapter({ transport, chainId: 1n, contract: CONTRACT, applicationRoot });
  const candidate = entries[0]!;
  const digest = bindingDigest({ chainId: chain.chainId, contract: chain.contract, tokenId: 1n,
    settlementId: ZERO_BYTES32, snapshotHash: ZERO_BYTES32, holder: candidate.holder,
    priorCommitment: candidate.previousCommitment, nextCommitment: candidate.recordCommitment,
    version: candidate.version, effectiveAt: candidate.effectiveAt }, candidate);
  transport.set({ applicationRoot: digest });
  await chain.refresh();
  const profile = new MerkleProofProfile(chain);
  const profiles = new ProofProfileRegistry();
  profiles.register(profile, sha256Hex(profile.id));
  const store = new ProjectionStore({ registerId: commitment(1), verificationProfile: sha256Hex(profile.id), profiles, adapter: chain });
  store.admit(1n, candidate, { profile: profile.id, remoteHeight: 0x1234n, payload: { path: [] } });
  assert.equal(store.holderAsOf(1n, 100n), ALICE);
  assert.equal(store.isFinalAsOf(1n, 100n), false);
});

test('a failed root read leaves the accepted finalized state unchanged', async () => {
  const transport = node();
  const chain = new EthereumChainAdapter({ transport, chainId: 1n, contract: CONTRACT, applicationRoot });
  await chain.refresh();
  transport.set({ finalized: { number: 0x1235n, stateRoot: commitment(2) }, applicationRoot: '0x' });
  await assert.rejects(() => chain.refresh(), /exactly bytes32/);
  assert.equal(chain.finalizedHeight, 0x1234n);
  assert.equal(chain.stateRootAt(0x1235n), undefined);
  assert.equal(chain.stateRootAt(0x1234n), commitment(0x777));
});
