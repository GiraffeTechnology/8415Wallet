import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionError } from '../../src/kit/engine/projection/errors.ts';
import { ZERO_BYTES32 } from '../../src/kit/engine/projection/types.ts';
import { ALICE, BOB, CAROL, admit, commitment, entry, gap, harness } from './support/fixtures.ts';

const rejects = (code: string, run: () => unknown): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProjectionError, `expected a ProjectionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const TOKEN = 1n;

/** Alice from 100, Bob from 130. The worked example from the discussion. */
const twoEntries = () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));
  return h;
};

// 1
test('history is append-only', () => {
  const h = twoEntries();
  const before = h.store.entries(TOKEN);
  assert.equal(before.length, 2);

  // The returned history is a copy; mutating it cannot reach the store.
  (before as unknown as unknown[]).push({});
  assert.equal(h.store.entries(TOKEN).length, 2);

  // And there is no path that rewrites or removes one.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(h.store));
  for (const forbidden of ['update', 'delete', 'remove', 'rewrite', 'setFinal', 'correct']) {
    assert.ok(!surface.includes(forbidden), `the store exposes ${forbidden}`);
  }
});

// 2
test('versions must be consecutive', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  rejects('NON_CONSECUTIVE_VERSION', () =>
    admit(h, TOKEN, entry({
      version: 3n, holder: BOB, effectiveAt: 130n,
      recordCommitment: commitment(2), previousCommitment: commitment(1),
    })));
  rejects('NON_CONSECUTIVE_VERSION', () =>
    admit(h, TOKEN, entry({
      version: 1n, holder: BOB, effectiveAt: 130n,
      recordCommitment: commitment(3), previousCommitment: commitment(1),
    })));
});

// 3
test('effectiveAt must strictly increase', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  for (const effectiveAt of [100n, 99n, 0n]) {
    rejects('EFFECTIVE_AT_NOT_INCREASING', () =>
      admit(h, TOKEN, entry({
        version: 2n, holder: BOB, effectiveAt,
        recordCommitment: commitment(2), previousCommitment: commitment(1),
      })));
  }
});

// 4
test('holderAsOf resolves at the interval boundaries', () => {
  const h = twoEntries();
  assert.equal(h.store.holderAsOf(TOKEN, 100n), ALICE);
  assert.equal(h.store.holderAsOf(TOKEN, 129n), ALICE);
  // The interval is half-open: 130 belongs to the entry that starts there.
  assert.equal(h.store.holderAsOf(TOKEN, 130n), BOB);
  assert.equal(h.store.holderAsOf(TOKEN, 1_000_000n), BOB);
});

// 5
test('isFinalAsOf is exactly the later-entry rule', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));

  // One entry: nothing is final, because no strictly later entry exists.
  assert.equal(h.store.isFinalAsOf(TOKEN, 100n), false);
  assert.equal(h.store.isFinalAsOf(TOKEN, 500n), false);

  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  assert.equal(h.store.isFinalAsOf(TOKEN, 99n), false);   // not covered
  assert.equal(h.store.isFinalAsOf(TOKEN, 100n), true);
  assert.equal(h.store.isFinalAsOf(TOKEN, 129n), true);
  assert.equal(h.store.isFinalAsOf(TOKEN, 130n), false);  // latest interval
  assert.equal(h.store.isFinalAsOf(TOKEN, 999n), false);
});

// 6
test('a holder is known while the answer is still provisional', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(h.store.holderAsOf(TOKEN, 140n), ALICE);
  // Provisional is not a field on the answer; it is the negation of the
  // separate finality question, which is the whole point of two accessors.
  assert.equal(h.store.isFinalAsOf(TOKEN, 140n), false);
});

// 7
test('closing a gap does not finalise anything', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  h.store.openGap(TOKEN, gap({ openedAt: 120n, settlementId: commitment(0x51) }));
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), false);

  h.store.cancelGap(TOKEN);
  assert.equal(h.store.openGapOf(TOKEN), ZERO_BYTES32);
  // The gap is closed and the instant is exactly as provisional as before.
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), false);
});

// 8
test('finality does not depend on gap state', () => {
  const h = twoEntries();
  const finalBefore = h.store.isFinalAsOf(TOKEN, 110n);
  h.store.openGap(TOKEN, gap({ openedAt: 105n, settlementId: commitment(0x52) }));
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), finalBefore);
  h.store.cancelGap(TOKEN);
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), finalBefore);
  assert.equal(finalBefore, true);
});

// 9
test('a verifying proof profile admits', () => {
  const h = harness();
  const result = admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(result.entry.holder, ALICE);
  assert.equal(h.store.entryCount(TOKEN), 1);
});

// 10
test('a refused proof profile admits nothing', () => {
  const h = harness();
  rejects('PROOF_PROFILE_REJECTED', () =>
    admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }), 'test:closed'));
  assert.equal(h.store.entryCount(TOKEN), 0);

  rejects('PROOF_PROFILE_REJECTED', () =>
    admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }), 'test:unknown'));
  assert.equal(h.store.entryCount(TOKEN), 0);
});

// 11
test('a replayed proof is rejected and the height never goes backwards', () => {
  const h = harness();
  h.store.admit(TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }),
    { profile: 'test:open', remoteHeight: 10n, payload: {} });

  // Same height again, and a lower one.
  for (const remoteHeight of [10n, 9n, 1n]) {
    rejects('PROOF_PROFILE_REJECTED', () =>
      h.store.admit(TOKEN, entry({
        version: 2n, holder: BOB, effectiveAt: 130n,
        recordCommitment: commitment(2), previousCommitment: commitment(1),
      }), { profile: 'test:open', remoteHeight, payload: {} }));
  }
  assert.equal(h.store.entryCount(TOKEN), 1);

  // A non-finalized height is refused too.
  h.adapter.setFinalizedThrough(10n);
  rejects('PROOF_PROFILE_REJECTED', () =>
    h.store.admit(TOKEN, entry({
      version: 2n, holder: BOB, effectiveAt: 130n,
      recordCommitment: commitment(2), previousCommitment: commitment(1),
    }), { profile: 'test:open', remoteHeight: 11n, payload: {} }));
  assert.equal(h.store.entryCount(TOKEN), 1);
});

// 12
test('the commitment chain is validated', () => {
  const h = harness();
  rejects('BROKEN_COMMITMENT_LINKAGE', () =>
    admit(h, TOKEN, entry({
      version: 1n, holder: ALICE, effectiveAt: 100n,
      recordCommitment: commitment(1), previousCommitment: commitment(99),
    })));

  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  rejects('BROKEN_COMMITMENT_LINKAGE', () =>
    admit(h, TOKEN, entry({
      version: 2n, holder: BOB, effectiveAt: 130n,
      recordCommitment: commitment(2), previousCommitment: commitment(42),
    })));
});

// 13
test('a historical holder is stable while a later admission changes finality', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(h.store.holderAsOf(TOKEN, 110n), ALICE);
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), false);

  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  // The holder at 110 never moved; only what can still change did.
  assert.equal(h.store.holderAsOf(TOKEN, 110n), ALICE);
  assert.equal(h.store.isFinalAsOf(TOKEN, 110n), true);
});

// 14
test('the core works with no settlement extension in play', () => {
  const h = twoEntries();
  assert.equal(h.store.openGapOf(TOKEN), ZERO_BYTES32);
  assert.equal(h.store.holderAsOf(TOKEN, 120n), ALICE);
  assert.equal(h.store.isFinalAsOf(TOKEN, 120n), true);
  assert.equal(h.store.entryCount(TOKEN), 2);
});

// 15
test('there is no ownership input that could rewrite a historical answer', () => {
  const h = twoEntries();
  const surface = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(h.store)),
    ...Object.getOwnPropertyNames(h.store),
  ];
  for (const forbidden of ['ownerOf', 'owner', 'currentOwner', 'setHolder', 'transfer']) {
    assert.ok(!surface.includes(forbidden), `the store exposes ${forbidden}`);
  }
  // A token with no projection answers by reverting, never by falling back.
  rejects('UNKNOWN_TOKEN', () => h.store.holderAsOf(7n, 120n));
  assert.equal(h.store.isFinalAsOf(7n, 120n), false);
});

// 16
test('a confirming entry finalises the preceding interval without a holder change', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(h.store.isFinalAsOf(TOKEN, 150n), false);

  // Same holder, later instant: the register confirming that nothing changed.
  admit(h, TOKEN, entry({
    version: 2n, holder: ALICE, effectiveAt: 200n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  assert.equal(h.store.holderAsOf(TOKEN, 150n), ALICE);
  assert.equal(h.store.isFinalAsOf(TOKEN, 150n), true);
});

// 17
test('an open gap changes no projection answer', () => {
  const h = twoEntries();
  const before = {
    holder: h.store.holderAsOf(TOKEN, 120n),
    final: h.store.isFinalAsOf(TOKEN, 120n),
    count: h.store.entryCount(TOKEN),
    current: h.store.currentEntry(TOKEN),
  };

  h.store.openGap(TOKEN, gap({ openedAt: 140n, settlementId: commitment(0x53) }));

  assert.equal(h.store.holderAsOf(TOKEN, 120n), before.holder);
  assert.equal(h.store.isFinalAsOf(TOKEN, 120n), before.final);
  assert.equal(h.store.entryCount(TOKEN), before.count);
  assert.deepEqual(h.store.currentEntry(TOKEN), before.current);

  // And at most one gap is open at a time.
  assert.throws(() => h.store.openGap(TOKEN, gap({ openedAt: 141n, settlementId: commitment(0x54) })));
});

// 18
test('cancellation leaves prior provisional history provisional', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  h.store.openGap(TOKEN, gap({ openedAt: 120n, settlementId: commitment(0x55) }));

  const before = h.store.holderAsOf(TOKEN, 140n);
  const finalBefore = h.store.isFinalAsOf(TOKEN, 140n);
  h.store.cancelGap(TOKEN);

  assert.equal(h.store.holderAsOf(TOKEN, 140n), before);
  assert.equal(h.store.isFinalAsOf(TOKEN, 140n), finalBefore);
  assert.equal(finalBefore, false);
  assert.equal(h.store.entryCount(TOKEN), 1);
  rejects('NO_OPEN_GAP', () => h.store.cancelGap(TOKEN));
});

// 19
test('an instant before the first entry reverts, while isFinalAsOf does not', () => {
  const h = twoEntries();
  rejects('INSTANT_NOT_COVERED', () => h.store.entryAsOf(TOKEN, 99n));
  rejects('INSTANT_NOT_COVERED', () => h.store.holderAsOf(TOKEN, 99n));
  assert.equal(h.store.isFinalAsOf(TOKEN, 99n), false);
  assert.equal(h.store.isFinalAsOf(TOKEN, 0n), false);
});

// 20
test('commitment uniqueness is per token, not across tokens', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));

  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  // A commitment already in this token's history cannot come back, even on a
  // well-linked entry.
  rejects('COMMITMENT_REUSED', () =>
    admit(h, TOKEN, entry({
      version: 3n, holder: ALICE, effectiveAt: 160n,
      recordCommitment: commitment(1), previousCommitment: commitment(2),
    })));
  assert.equal(h.store.entryCount(TOKEN), 2);

  // The same commitment on a different token is admitted. Cross-token replay
  // is the registrar's or the application's concern, not the projection's.
  const other = 2n;
  admit(h, other, entry({ version: 1n, holder: CAROL, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(h.store.entryCount(other), 1);
  assert.equal(h.store.holderAsOf(other, 100n), CAROL);
});

test('the worked example from the discussion resolves as described', () => {
  const h = harness();
  // Alice confirmed from 100. Bob buys at 120; the register records Bob
  // effective at 130, and the entry lands later.
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));

  assert.equal(h.store.holderAsOf(TOKEN, 140n), ALICE);
  assert.equal(h.store.isFinalAsOf(TOKEN, 140n), false);

  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  assert.equal(h.store.holderAsOf(TOKEN, 140n), BOB);
  // Everything from 100 up to but excluding 130 is now final.
  assert.equal(h.store.isFinalAsOf(TOKEN, 100n), true);
  assert.equal(h.store.isFinalAsOf(TOKEN, 129n), true);
  // 130 onward stays provisional until a later entry closes the interval.
  assert.equal(h.store.isFinalAsOf(TOKEN, 130n), false);
});

test('a malformed candidate is refused before anything is written', () => {
  const h = harness();
  const bad = [
    { ...entry({ version: 1n, holder: 'not-an-address', effectiveAt: 100n, recordCommitment: commitment(1) }) },
    { ...entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: 'nope' }) },
    { ...entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1), registryReference: 'not-bytes32' }) },
    { ...entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: ZERO_BYTES32 }) },
  ];
  for (const candidate of bad) {
    rejects('MALFORMED_ENTRY', () => admit(h, TOKEN, candidate));
  }
  assert.equal(h.store.entryCount(TOKEN), 0);
});

// The four projection invariants as the standard states them, including the
// two this implementation originally got wrong by following a repository
// document instead of the standard.

test('invariant 1: the first entry is version 1 with a zero previousCommitment', () => {
  const h = harness();
  rejects('NON_CONSECUTIVE_VERSION', () =>
    admit(h, TOKEN, entry({ version: 2n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) })));
  rejects('NON_CONSECUTIVE_VERSION', () =>
    admit(h, TOKEN, entry({ version: 0n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) })));
  rejects('BROKEN_COMMITMENT_LINKAGE', () =>
    admit(h, TOKEN, entry({
      version: 1n, holder: ALICE, effectiveAt: 100n,
      recordCommitment: commitment(1), previousCommitment: commitment(9),
    })));

  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  assert.equal(h.store.entryCount(TOKEN), 1);
});

test('invariant 2: admission closes the prior entry with the new effective time', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));

  // The latest entry always carries a zero supersededAt.
  assert.equal(h.store.entryAt(TOKEN, 1n).supersededAt, 0n);

  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  // The prior entry's interval is closed by the register's effective time,
  // not by when the chain learned of the change.
  assert.equal(h.store.entryAt(TOKEN, 1n).supersededAt, 130n);
  assert.equal(h.store.entryAt(TOKEN, 2n).supersededAt, 0n);

  // Nothing else about the closed entry moved.
  const first = h.store.entryAt(TOKEN, 1n);
  assert.equal(first.holder, ALICE);
  assert.equal(first.effectiveAt, 100n);
  assert.equal(first.recordCommitment, commitment(1));
});

test('entryAt is indexed by version, and an unknown version reverts', () => {
  const h = twoEntries();
  assert.equal(h.store.entryAt(TOKEN, 1n).holder, ALICE);
  assert.equal(h.store.entryAt(TOKEN, 2n).holder, BOB);
  rejects('UNKNOWN_VERSION', () => h.store.entryAt(TOKEN, 0n));
  rejects('UNKNOWN_VERSION', () => h.store.entryAt(TOKEN, 3n));
  rejects('UNKNOWN_TOKEN', () => h.store.entryAt(9n, 1n));
});

test('holderAsOf answers the holder alone', () => {
  const h = twoEntries();
  const answer = h.store.holderAsOf(TOKEN, 120n);
  // Not an object carrying a finality flag: the standard exposes three facts
  // through three accessors so a consumer cannot mistake which it was given.
  assert.equal(typeof answer, 'string');
  assert.equal(answer, ALICE);
});

test('openGapOf reports the zero word when no gap is open', () => {
  const h = twoEntries();
  assert.equal(h.store.openGapOf(TOKEN), ZERO_BYTES32);
  const opened = h.store.openGap(TOKEN, gap({ settlementId: commitment(0x77) }));
  assert.equal(h.store.openGapOf(TOKEN), opened.settlementId);
  assert.equal(h.store.settlement(opened.settlementId).status, 'OPEN');
});

test('a settlement record keeps its outcome after the gap closes', () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));

  const cancelled = h.store.openGap(TOKEN, gap({ settlementId: commitment(0x81) }));
  h.store.cancelGap(TOKEN);
  assert.equal(h.store.settlement(cancelled.settlementId).status, 'CANCELLED');
  assert.equal(h.store.openGapOf(TOKEN), ZERO_BYTES32);

  const admittedGap = h.store.openGap(TOKEN, gap({ settlementId: commitment(0x82) }));
  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));
  assert.equal(h.store.settlement(admittedGap.settlementId).status, 'ADMITTED');
  assert.equal(h.store.openGapOf(TOKEN), ZERO_BYTES32);

  // An unknown settlement reads as NONE rather than reverting.
  assert.equal(h.store.settlement(commitment(0xff)).status, 'NONE');
});
