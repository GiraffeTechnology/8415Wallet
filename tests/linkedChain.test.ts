import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildLinkedChainView, readLinkedChainView, renderLinkedChain, LinkedChainInputError } from '../src/index.ts';
import type { LinkedChainSnapshot, LinkedCompletionEvidence, LinkedLeg } from '../src/sdk/linked.ts';
import { ZERO_ADDRESS, ZERO_BYTES32 } from '../src/sdk/types.ts';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
// Deliberately descending numeric addresses: addresses are NOT positions.
const parties = [4, 3, 2, 1].map(n => `0x${n.toString(16).padStart(40, '0')}`);
const initial = hash(100);
function chain(addresses = parties): LinkedChainSnapshot {
  return {
    asset: { chainId: 11155111n, contract: `0x${'ab'.repeat(20)}`, tokenId: (1n << 200n) + 1n },
    sequenceId: hash(200), revision: 3n, blockNumber: 10n, blockHash: hash(300),
    initialOccurrenceId: initial, initialHolder: addresses[0]!,
    legs: addresses.slice(1).map((buyer, i) => ({
      id: hash(i + 1), predecessorId: i === 0 ? null : hash(i),
      buyerOccurrenceId: hash(101 + i), seller: addresses[i]!, buyer,
      originalPayer: buyer, termsHash: hash(400 + i), paymentAsset: ZERO_ADDRESS,
      principal: BigInt(i + 1) * 1_000_000_000_000_000_001n, outcome: 'reserved',
    })),
  };
}
function evidence(snapshot: LinkedChainSnapshot, owner = 3, holder = 1): Extract<LinkedCompletionEvidence, { kind: 'bound' }> {
  const position = (i: number) => i === 0
    ? { occurrenceId: snapshot.initialOccurrenceId, account: snapshot.initialHolder }
    : { occurrenceId: snapshot.legs[i - 1]!.buyerOccurrenceId, account: snapshot.legs[i - 1]!.buyer };
  return {
    kind: 'bound', asset: { ...snapshot.asset }, sequenceId: snapshot.sequenceId,
    revision: snapshot.revision, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash,
    owner: position(owner), admittedHolder: position(holder), protocolFinality: false,
  };
}
function changeLeg(snapshot: LinkedChainSnapshot, index: number, delta: Partial<LinkedLeg>): LinkedChainSnapshot {
  return { ...snapshot, legs: snapshot.legs.map((leg, i) => i === index ? { ...leg, ...delta } : leg) };
}
function refused(snapshot: LinkedChainSnapshot, proof: LinkedCompletionEvidence, code: string): void {
  assert.throws(() => buildLinkedChainView(snapshot, proof), error =>
    error instanceof LinkedChainInputError && error.code === code);
}

describe('CP-01 dual-position predicate (snapshot only)', () => {
  for (let owner = 0; owner <= 3; owner++) {
    for (let holder = 0; holder <= 3; holder++) {
      test(`owner occurrence ${owner}, admitted holder ${holder}`, () => {
        const snapshot = chain();
        const view = buildLinkedChainView(snapshot, evidence(snapshot, owner, holder));
        assert.deepEqual(view.completionPrefix, snapshot.legs.slice(0, Math.min(owner, holder)).map(x => x.id));
        assert.deepEqual(view.detachedLegIds, []); // condition != execution
        assert.equal(view.returnBoundary.occurrenceId, initial);
        assert.equal(view.protocolFinality, false);
        assert.equal(view.executionRequired, true);
      });
    }
  }
  test('protocol final, provisional and unavailable never alter commercial predicate', () => {
    const snapshot = chain();
    for (const protocolFinality of [true, false, null]) {
      const view = buildLinkedChainView(snapshot, { ...evidence(snapshot), protocolFinality });
      assert.deepEqual(view.completionPrefix, [hash(1)]);
      assert.equal(view.protocolFinality, protocolFinality);
    }
  });
  test('owner does not substitute for unavailable or ambiguous admitted evidence', () => {
    for (const kind of ['unavailable', 'ambiguous'] as const) {
      const view = buildLinkedChainView(chain(), { kind });
      assert.deepEqual(view.completionPrefix, []);
      assert(view.legs.every(x => x.completionPredicate === 'unavailable'));
      assert.equal(view.protocolFinality, null);
    }
  });
  test('repeated address A -> B -> A -> D requires distinct bound occurrences', () => {
    const snapshot = chain([parties[0]!, parties[1]!, parties[0]!, parties[3]!]);
    assert.deepEqual(buildLinkedChainView(snapshot, evidence(snapshot, 3, 0)).completionPrefix, []);
    assert.deepEqual(buildLinkedChainView(snapshot, evidence(snapshot, 3, 2)).completionPrefix, [hash(1), hash(2)]);
    assert.equal(evidence(snapshot, 3, 0).admittedHolder.account, evidence(snapshot, 3, 2).admittedHolder.account);
  });
  test('preserves large integers, principal isolation and original payer', () => {
    const snapshot = changeLeg(chain(), 0, { originalPayer: `0x${'ff'.repeat(20)}` });
    const view = buildLinkedChainView(snapshot, evidence(snapshot));
    assert.equal(view.legs[0]!.originalPayer, snapshot.legs[0]!.originalPayer);
    assert.deepEqual(view.legs.map(x => x.principal), snapshot.legs.map(x => x.principal));
  });
  test('pure: frozen source records remain unchanged after repeated evaluations', () => {
    const snapshot = chain();
    snapshot.legs.forEach(Object.freeze);
    Object.freeze(snapshot.legs);
    Object.freeze(snapshot);
    const first = buildLinkedChainView(snapshot, evidence(snapshot, 3, 3));
    const second = buildLinkedChainView(snapshot, evidence(snapshot, 3, 3));
    assert.deepEqual(first, second);
    assert(snapshot.legs.every(x => x.outcome === 'reserved'));
    assert.match(first.note, /not payment release or recall authorization/);
  });
});

describe('executed prefix and return boundaries', () => {
  test('released AB stays detached despite later holder regression', () => {
    const snapshot = changeLeg(chain(), 0, { outcome: 'released' });
    const view = buildLinkedChainView(snapshot, evidence(snapshot, 3, 0));
    assert.deepEqual(view.detachedLegIds, [hash(1)]);
    assert.equal(view.returnBoundary.account, parties[1]);
    assert.equal(view.returnBoundary.occurrenceId, hash(101));
    assert.equal(view.legs[0]!.completionPredicate, 'not-applicable');
    assert.deepEqual(view.completionPrefix, []);
  });
  test('detached history survives unavailable evidence; no new release is invented', () => {
    const snapshot = changeLeg(chain(), 0, { outcome: 'released' });
    const view = buildLinkedChainView(snapshot, { kind: 'unavailable' });
    assert.deepEqual(view.detachedLegIds, [hash(1)]);
    assert.deepEqual(view.completionPrefix, []);
    assert.equal(view.returnBoundary.account, parties[1]);
  });
  test('head detachment retains all existing tail records', () => {
    const snapshot = changeLeg(chain(), 0, { outcome: 'released' });
    const view = buildLinkedChainView(snapshot, evidence(snapshot, 3, 2));
    assert.deepEqual(view.completionPrefix, [hash(2)]);
    assert.equal(view.legs.length, 3);
    assert.equal(view.legs[2]!.outcome, 'reserved');
  });
  test('all released: latest buyer is the boundary, no duplicate release preview', () => {
    const snapshot = { ...chain(), legs: chain().legs.map(x => ({ ...x, outcome: 'released' as const })) };
    const view = buildLinkedChainView(snapshot, evidence(snapshot, 3, 3));
    assert.equal(view.detachedLegIds.length, 3);
    assert.deepEqual(view.completionPrefix, []);
    assert.equal(view.returnBoundary.account, parties[3]);
  });
  for (const outcome of ['returning', 'refunded'] as const) {
    test(`${outcome} cannot race into a release preview on late admission`, () => {
      const snapshot = changeLeg(chain(), 2, { outcome });
      const view = buildLinkedChainView(snapshot, evidence(snapshot, 3, 3));
      assert.deepEqual(view.completionPrefix, []);
      assert.equal(view.legs[2]!.outcome, outcome);
    });
  }
  test('cannot mark a descendant released through an unresolved predecessor', () => {
    refused(changeLeg(chain(), 1, { outcome: 'released' }), { kind: 'unavailable' }, 'LINKED_RELEASE_PREFIX_INVALID');
  });
  test('cannot complete upstream refund before downstream returns', () => {
    refused(changeLeg(chain(), 0, { outcome: 'refunded' }), { kind: 'unavailable' }, 'LINKED_REFUND_SUFFIX_INVALID');
  });
});

describe('evidence domain and freshness bindings', () => {
  const deltas = [
    ['chain', (p: ReturnType<typeof evidence>) => ({ ...p, asset: { ...p.asset, chainId: 1n } }), 'LINKED_EVIDENCE_BINDING_MISMATCH'],
    ['contract', (p: ReturnType<typeof evidence>) => ({ ...p, asset: { ...p.asset, contract: `0x${'cc'.repeat(20)}` } }), 'LINKED_EVIDENCE_BINDING_MISMATCH'],
    ['token', (p: ReturnType<typeof evidence>) => ({ ...p, asset: { ...p.asset, tokenId: 5n } }), 'LINKED_EVIDENCE_BINDING_MISMATCH'],
    ['sequence', (p: ReturnType<typeof evidence>) => ({ ...p, sequenceId: hash(999) }), 'LINKED_EVIDENCE_BINDING_MISMATCH'],
    ['revision', (p: ReturnType<typeof evidence>) => ({ ...p, revision: p.revision - 1n }), 'LINKED_EVIDENCE_BINDING_MISMATCH'],
    ['block number', (p: ReturnType<typeof evidence>) => ({ ...p, blockNumber: 9n }), 'LINKED_EVIDENCE_BLOCK_MISMATCH'],
    ['reorg hash', (p: ReturnType<typeof evidence>) => ({ ...p, blockHash: hash(999) }), 'LINKED_EVIDENCE_BLOCK_MISMATCH'],
    ['owner binding', (p: ReturnType<typeof evidence>) => ({ ...p, owner: { ...p.owner, account: parties[0]! } }), 'LINKED_OWNER_OCCURRENCE_MISMATCH'],
    ['holder binding', (p: ReturnType<typeof evidence>) => ({ ...p, admittedHolder: { ...p.admittedHolder, account: parties[0]! } }), 'LINKED_HOLDER_OCCURRENCE_MISMATCH'],
    ['unknown occurrence', (p: ReturnType<typeof evidence>) => ({ ...p, admittedHolder: { ...p.admittedHolder, occurrenceId: hash(999) } }), 'LINKED_HOLDER_OCCURRENCE_MISMATCH'],
  ] as const;
  for (const [label, change, code] of deltas) {
    test(`refuses ${label} mismatch`, () => {
      const snapshot = chain();
      refused(snapshot, change(evidence(snapshot)), code);
    });
  }
  test('old evidence cannot bind a concurrently extended/revised sequence', () => {
    const old = chain();
    refused({ ...old, revision: old.revision + 1n }, evidence(old), 'LINKED_EVIDENCE_BINDING_MISMATCH');
  });
});

describe('malformed sequence refuses instead of showing success', () => {
  const deltas: readonly [string, number, Partial<LinkedLeg>, string][] = [
    ['duplicate leg', 1, { id: hash(1) }, 'LINKED_LEG_ID_INVALID'],
    ['zero leg', 0, { id: ZERO_BYTES32 }, 'LINKED_LEG_ID_INVALID'],
    ['broken predecessor', 1, { predecessorId: null }, 'LINKED_PREDECESSOR_MISMATCH'],
    ['broken seller chain', 1, { seller: parties[0]! }, 'LINKED_PREDECESSOR_MISMATCH'],
    ['reused occurrence', 1, { buyerOccurrenceId: hash(101) }, 'LINKED_OCCURRENCE_REUSED'],
    ['initial occurrence collision', 0, { buyerOccurrenceId: initial }, 'LINKED_OCCURRENCE_REUSED'],
    ['zero buyer', 0, { buyer: ZERO_ADDRESS }, 'LINKED_PARTICIPANT_INVALID'],
    ['malformed payer', 0, { originalPayer: 'buyer' }, 'LINKED_PARTICIPANT_INVALID'],
    ['missing terms', 0, { termsHash: ZERO_BYTES32 }, 'LINKED_TERMS_INVALID'],
    ['negative principal', 0, { principal: -1n }, 'LINKED_TERMS_INVALID'],
    ['overflow principal', 0, { principal: 1n << 256n }, 'LINKED_TERMS_INVALID'],
    ['invalid denomination', 0, { paymentAsset: 'ETH' }, 'LINKED_TERMS_INVALID'],
  ];
  for (const [label, index, delta, code] of deltas) {
    test(label, () => refused(changeLeg(chain(), index, delta), { kind: 'unavailable' }, code));
  }
  test('bounds sequence work', () => {
    const snapshot = chain();
    refused({ ...snapshot, legs: Array.from({ length: 4097 }, () => snapshot.legs[0]!) },
      { kind: 'unavailable' }, 'LINKED_SEQUENCE_LIMIT');
  });
  test('empty sequence has no releasable or detached leg', () => {
    const snapshot = { ...chain(), legs: [] };
    const view = buildLinkedChainView(snapshot, evidence(snapshot, 0, 0));
    assert.deepEqual(view.completionPrefix, []);
    assert.deepEqual(view.detachedLegIds, []);
  });
});

describe('public read-only integration seam', () => {
  test('renderer distinguishes predicate, executed outcome and protocol provisional status', () => {
    const snapshot = chain();
    const view = buildLinkedChainView(snapshot, evidence(snapshot));
    const text = renderLinkedChain(view);
    assert.match(text, /READ-ONLY SNAPSHOT/);
    assert.match(text, /ERC temporal finality: provisional/);
    assert.match(text, /Recorded outcome: reserved; completion predicate: satisfied/);
    assert.match(text, /Predicate-satisfying prefix \(not executed\): 1/);
    assert.match(text, /Detached history: 0/);
    assert(text.includes(snapshot.asset.tokenId.toString()));
    assert(text.includes(snapshot.blockHash));
    assert.notEqual(view.asset, snapshot.asset);
  });
  test('unavailable finality is not displayed as provisional', () => {
    const view = buildLinkedChainView(chain(), { kind: 'unavailable' });
    assert.match(renderLinkedChain(view), /ERC temporal finality: unavailable/);
  });
  test('reads once with the exact requested sequence and returns the same preview', async () => {
    const snapshot = chain();
    let calls = 0;
    const result = await readLinkedChainView({ observe: async sequenceId => {
      calls++;
      assert.equal(sequenceId, snapshot.sequenceId);
      return { snapshot, evidence: evidence(snapshot) };
    } }, snapshot.sequenceId);
    assert.equal(calls, 1);
    assert.deepEqual(result, buildLinkedChainView(snapshot, evidence(snapshot)));
  });
  test('does not accept another sequence returned by the backend', async () => {
    const snapshot = chain();
    await assert.rejects(readLinkedChainView({ observe: async () => ({ snapshot, evidence: evidence(snapshot) }) }, hash(999)),
      { code: 'LINKED_SEQUENCE_ID_MISMATCH' });
  });
  test('transport failure is not cached success or an invented holder', async () => {
    const failure = new Error('transport unavailable');
    await assert.rejects(readLinkedChainView({ observe: async () => { throw failure; } }, chain().sequenceId),
      error => error === failure);
  });
});
