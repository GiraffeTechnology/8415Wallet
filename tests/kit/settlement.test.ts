import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettlementEngine } from '../../src/kit/engine/settlement/engine.ts';
import { AllowListAuthority } from '../../src/kit/engine/settlement/authority.ts';
import { ProjectionError } from '../../src/kit/engine/projection/errors.ts';
import { ZERO_BYTES32, type Instant } from '../../src/kit/engine/projection/types.ts';
import { ALICE, BOB, CAROL, admit, commitment, entry, harness } from './support/fixtures.ts';

const TOKEN = 1n;
const SETTLEMENT = commitment(0x5e77);
const PERIOD = 86_400n;

const rejects = (code: string, run: () => unknown): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ProjectionError, `expected ProjectionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

class TestClock {
  #now: Instant;
  constructor(now: Instant) { this.#now = now; }
  now(): Instant { return this.#now; }
  advance(by: Instant): void { this.#now += by; }
}

/** ALICE is the settlement authority. BOB holds nothing and may relay. */
const scene = () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  const clock = new TestClock(1_000n);
  const engine = new SettlementEngine({
    store: h.store,
    authority: new AllowListAuthority([ALICE]),
    clock,
    settlementPeriod: PERIOD,
  });
  return { h, clock, engine };
};

const begin = (s: ReturnType<typeof scene>, over: Partial<Parameters<SettlementEngine['begin']>[0]> = {}) =>
  s.engine.begin({
    tokenId: TOKEN,
    settlementId: SETTLEMENT,
    initiator: ALICE,
    expectedHolder: BOB,
    snapshotHash: commitment(0x5a),
    deadline: s.clock.now() + 3_600n,
    ...over,
  });

const nextEntry = (effectiveAt = 200n, holder = BOB) =>
  entry({ version: 2n, holder, effectiveAt, recordCommitment: commitment(2), previousCommitment: commitment(1) });

test('only a settlement authority may open a gap', () => {
  const s = scene();
  rejects('NOT_SETTLEMENT_AUTHORITY', () => begin(s, { initiator: BOB }));
  rejects('NOT_SETTLEMENT_AUTHORITY', () => begin(s, { initiator: CAROL }));
  assert.equal(s.engine.openGapOf(TOKEN), ZERO_BYTES32);

  const opened = begin(s);
  assert.equal(opened.status, 'OPEN');
  assert.equal(s.engine.openGapOf(TOKEN), SETTLEMENT);
});

test('settlement authority is separate from holding the token', () => {
  const s = scene();
  // ALICE is the confirmed holder and also the authority here, but the two
  // are unrelated: the authority policy is never handed an owner to consult.
  assert.equal(s.h.store.holderAsOf(TOKEN, 150n), ALICE);
  assert.equal(s.engine.isSettlementAuthority(TOKEN, ALICE), true);
  assert.equal(s.engine.isSettlementAuthority(TOKEN, BOB), false);

  // A token with no projection at all still answers the authority question.
  assert.equal(s.engine.isSettlementAuthority(999n, ALICE), true);
});

test('the deadline is bounded by the settlement period', () => {
  const s = scene();
  rejects('DEADLINE_OUT_OF_RANGE', () => begin(s, { deadline: s.clock.now() }));
  rejects('DEADLINE_OUT_OF_RANGE', () => begin(s, { deadline: s.clock.now() - 1n }));
  rejects('DEADLINE_OUT_OF_RANGE', () => begin(s, { deadline: s.clock.now() + PERIOD + 1n }));

  const opened = begin(s, { deadline: s.clock.now() + PERIOD });
  assert.equal(opened.deadline, 1_000n + PERIOD);
  assert.equal(s.engine.settlementPeriod, PERIOD);
});

test('a token has at most one open gap, and an id is never reused', () => {
  const s = scene();
  begin(s);
  rejects('GAP_ALREADY_OPEN', () => begin(s, { settlementId: commitment(0x5e78) }));
  rejects('SETTLEMENT_EXISTS', () => begin(s, { settlementId: SETTLEMENT }));

  s.clock.advance(3_601n);
  s.engine.cancel(SETTLEMENT, ALICE);
  // The identifier stays spent after the gap closes.
  rejects('SETTLEMENT_EXISTS', () => begin(s, { settlementId: SETTLEMENT }));
});

test('admission closes the gap and records the outcome', () => {
  const s = scene();
  begin(s);
  const result = s.engine.finalize(SETTLEMENT, nextEntry(), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  });

  assert.equal(result.gapClosed, true);
  assert.equal(s.engine.openGapOf(TOKEN), ZERO_BYTES32);
  assert.equal(s.engine.settlement(SETTLEMENT).status, 'ADMITTED');
  assert.equal(s.h.store.entryCount(TOKEN), 2);
});

test('anyone may relay a proof, and relaying grants nothing', () => {
  const s = scene();
  begin(s);
  // CAROL is neither authority nor holder nor the expected holder.
  const result = s.engine.finalize(SETTLEMENT, nextEntry(), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  });
  assert.equal(result.entry.holder, BOB);
  assert.equal(s.engine.isSettlementAuthority(TOKEN, CAROL), false);
  assert.equal(s.h.store.holderAsOf(TOKEN, 250n), BOB);
});

test('an admission must carry the holder the gap was opened for', () => {
  const s = scene();
  begin(s);
  rejects('HOLDER_MISMATCH', () => s.engine.finalize(SETTLEMENT, nextEntry(200n, CAROL), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  }));
  assert.equal(s.h.store.entryCount(TOKEN), 1);
  assert.equal(s.engine.openGapOf(TOKEN), SETTLEMENT);
});

test('cancellation is not finality', () => {
  const s = scene();
  begin(s);
  const finalBefore = s.h.store.isFinalAsOf(TOKEN, 150n);
  const holderBefore = s.h.store.holderAsOf(TOKEN, 150n);

  s.clock.advance(3_601n);
  const cancelled = s.engine.cancel(SETTLEMENT, ALICE, commitment(0xdead));

  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(s.h.store.isFinalAsOf(TOKEN, 150n), finalBefore);
  assert.equal(s.h.store.holderAsOf(TOKEN, 150n), holderBefore);
  assert.equal(finalBefore, false);
  assert.equal(s.h.store.entryCount(TOKEN), 1);
});

test('gap closure by admission is not finality either', () => {
  const s = scene();
  begin(s);
  s.engine.finalize(SETTLEMENT, nextEntry(), { profile: 'test:open', remoteHeight: 500n, payload: {} });

  // The gap closed and an entry landed. The instants the new entry covers are
  // still provisional: only a further entry closes that interval.
  assert.equal(s.engine.openGapOf(TOKEN), ZERO_BYTES32);
  assert.equal(s.h.store.isFinalAsOf(TOKEN, 250n), false);
  // What did become final is the interval the new entry closed behind it.
  assert.equal(s.h.store.isFinalAsOf(TOKEN, 150n), true);
});

test('timeout expiry is not finality, and is not an outcome', () => {
  const s = scene();
  begin(s, { deadline: s.clock.now() + 10n });
  assert.equal(s.engine.hasExpired(SETTLEMENT), false);

  s.clock.advance(11n);
  assert.equal(s.engine.hasExpired(SETTLEMENT), true);

  // Expiry changes nothing by itself: the gap is still open, the projection
  // untouched, and nothing became final.
  assert.equal(s.engine.openGapOf(TOKEN), SETTLEMENT);
  assert.equal(s.engine.settlement(SETTLEMENT).status, 'OPEN');
  assert.equal(s.h.store.isFinalAsOf(TOKEN, 150n), false);
  assert.equal(s.h.store.entryCount(TOKEN), 1);
});

test('an expired gap can only be cancelled by its initiator', () => {
  const s = scene();
  begin(s, { deadline: s.clock.now() + 10n });
  s.clock.advance(11n);

  rejects('SETTLEMENT_EXPIRED', () => s.engine.finalize(SETTLEMENT, nextEntry(), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  }));

  rejects('NOT_SETTLEMENT_AUTHORITY', () => s.engine.cancel(SETTLEMENT, CAROL));
  const cancelled = s.engine.cancel(SETTLEMENT, ALICE);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(s.h.store.isFinalAsOf(TOKEN, 150n), false);
});

test('cancellation requires the initiator and a time strictly after the deadline', () => {
  const s = scene();
  begin(s);
  rejects('NOT_SETTLEMENT_AUTHORITY', () => s.engine.cancel(SETTLEMENT, BOB));
  rejects('NOT_SETTLEMENT_AUTHORITY', () => s.engine.cancel(SETTLEMENT, CAROL));
  assert.equal(s.engine.openGapOf(TOKEN), SETTLEMENT);
  rejects('DEADLINE_OUT_OF_RANGE', () => s.engine.cancel(SETTLEMENT, ALICE));
  s.clock.advance(3_600n);
  rejects('DEADLINE_OUT_OF_RANGE', () => s.engine.cancel(SETTLEMENT, ALICE));
  assert.equal(s.engine.openGapOf(TOKEN), SETTLEMENT);
  s.clock.advance(1n);
  assert.equal(s.engine.cancel(SETTLEMENT, ALICE).status, 'CANCELLED');
});

test('a closed gap cannot be reopened, refinalized or recancelled', () => {
  const s = scene();
  begin(s);
  s.clock.advance(3_601n);
  s.engine.cancel(SETTLEMENT, ALICE);

  rejects('NO_OPEN_GAP', () => s.engine.cancel(SETTLEMENT, ALICE));
  rejects('NO_OPEN_GAP', () => s.engine.finalize(SETTLEMENT, nextEntry(), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  }));
  rejects('NO_OPEN_GAP', () => s.engine.finalize(commitment(0xabc), nextEntry(), {
    profile: 'test:open', remoteHeight: 500n, payload: {},
  }));
});

test('the settlement engine exposes no rejection, freeze or override path', () => {
  const s = scene();
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(s.engine));
  for (const forbidden of ['reject', 'veto', 'freeze', 'revoke', 'rollback', 'override', 'setFinal', 'unwind']) {
    assert.ok(!surface.includes(forbidden), `the settlement engine exposes ${forbidden}`);
  }
  assert.deepEqual(
    surface.filter((name) => name !== 'constructor').sort(),
    ['begin', 'cancel', 'finalize', 'hasExpired', 'isSettlementAuthority', 'openGapOf', 'settlement', 'settlementPeriod'],
  );
});

test('a gap on one token leaves every other token alone', () => {
  const s = scene();
  admit(s.h, 2n, entry({ version: 1n, holder: CAROL, effectiveAt: 100n, recordCommitment: commitment(0xb1) }));
  begin(s);

  assert.equal(s.engine.openGapOf(2n), ZERO_BYTES32);
  assert.equal(s.h.store.holderAsOf(2n, 150n), CAROL);
  assert.equal(s.h.store.isFinalAsOf(2n, 150n), false);
});
