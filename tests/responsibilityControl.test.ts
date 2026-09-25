import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  prepareResponsibilityTransition as prepare, ResponsibilityControlError,
  type ResponsibilityState, type ResponsibilityCommand, type ResponsibilityFacts,
  type ResponsibilityLeg, type ResponsibilityProposal,
} from '../src/controls/responsibility.ts';

// Model fixtures only: these objects are NOT cryptographic authorization evidence.
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const account = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
function empty(): ResponsibilityState {
  return { domain: { chainId: 11155111n, token: account(99), tokenId: 1n,
    sequenceId: hash(90), controlId: hash(91) }, revision: 0n,
  initial: { occurrenceId: hash(100), account: account(4) }, legs: [], callback: null };
}
function leg(n: number): ResponsibilityLeg {
  return { id: hash(n), buyer: { occurrenceId: hash(100 + n), account: account(4 - n) },
    termsHash: hash(200 + n), acceptanceHash: hash(300 + n),
    returnAuthority: account(80 + n), returnConditionHash: hash(400 + n), outcome: 'active' };
}
function facts(s: ResponsibilityState, extra: Partial<ResponsibilityFacts> = {}): ResponsibilityFacts {
  return { domain: s.domain, expectedRevision: s.revision, actor: account(4), ...extra };
}
function command(s: ResponsibilityState, action: Record<string, unknown>): ResponsibilityCommand {
  return { domain: s.domain, expectedRevision: s.revision, ...action } as ResponsibilityCommand;
}
function forward(s: ResponsibilityState, next = leg(s.legs.length + 1)) {
  const c = command(s, { kind: 'forward', leg: next, inherited: s.legs.filter(l => l.outcome === 'active')
    .map(l => ({ legId: l.id, termsHash: l.termsHash, acceptanceHash: l.acceptanceHash })) }) as Extract<ResponsibilityCommand, { kind: 'forward' }>;
  return { c, f: facts(s, { actor: s.legs.at(-1)?.buyer.account ?? s.initial.account, recipientAcceptance: structuredClone(c) }) };
}
function chain(): ResponsibilityState {
  let s = empty();
  for (let i = 0; i < 3; i++) { const { c, f } = forward(s); s = prepare(s, c, f).next; }
  return s;
}
function completion(s: ResponsibilityState, holder: number, owner = 3): ResponsibilityFacts {
  const pos = (n: number) => n === 0 ? s.initial : s.legs[n - 1]!.buyer;
  return facts(s, { completion: { owner: pos(owner), admittedHolder: pos(holder), protocolFinality: false } });
}
function begin(s: ResponsibilityState, root = 1): ResponsibilityProposal {
  return prepare(s, command(s, { kind: 'begin-return', rootLegId: hash(root) }), facts(s, {
    actor: account(80 + root), callbackConditionHash: hash(400 + root),
  }));
}
function hop(s: ResponsibilityState, n: number, root = 1): ResponsibilityProposal {
  return prepare(s, command(s, { kind: 'return-hop', legId: hash(n) }), facts(s, { actor: account(80 + root) }));
}
function refused(fn: () => unknown, code: string): void {
  assert.throws(fn, e => e instanceof ResponsibilityControlError && e.code === code);
}

describe('independent control proposals, no escrow dependency', () => {
  test('standalone starts with no dependencies and linked forwarding inherits only active terms', () => {
    const s = chain();
    assert.equal(s.legs.length, 3);
    assert.equal(s.revision, 3n);
    assert(!JSON.stringify(s, (_, v) => typeof v === 'bigint' ? `${v}` : v).includes('escrow'));
    const { c, f } = forward(empty());
    const p = prepare(empty(), c, f);
    assert.equal(p.status, 'UNCOMMITTED_PROPOSAL');
    assert.equal(p.requiresAtomicAuthenticatedExecution, true);
    assert.equal(p.effects.length, 1);
    assert.deepEqual(p.effects[0]!.from, empty().initial);
    assert.deepEqual(p.effects[0]!.to, leg(1).buyer);
  });
  test('CP-01 owner D / holder B completes AB without payments or protocol temporal finality', () => {
    const s = chain();
    for (const temporal of [true, false, null]) {
      const f = completion(s, 1);
      const p = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(1) }),
        { ...f, completion: { ...f.completion!, protocolFinality: temporal } });
      assert.deepEqual(p.next.legs.map(l => l.outcome), ['completed', 'active', 'active']);
      assert.deepEqual(p.effects, []);
      assert.equal(s.legs[0]!.outcome, 'active');
    }
  });
  for (const holder of [0, 1, 2, 3]) {
    for (const through of [1, 2, 3]) {
      test(`holder occurrence ${holder}, requested completed prefix ${through}`, () => {
        const s = chain();
        const apply = () => prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(through) }), completion(s, holder));
        if (holder < through) refused(apply, 'CONTROL_DUAL_POSITION_REQUIRED');
        else assert.equal(apply().next.legs.filter(l => l.outcome === 'completed').length, through);
      });
    }
  }
  test('a detached prefix is excluded from downstream inherited scope', () => {
    const s = chain();
    const completed = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(1) }), completion(s, 1)).next;
    const { c, f } = forward(completed, { ...leg(3), id: hash(4), acceptanceHash: hash(304),
      buyer: { occurrenceId: hash(104), account: account(7) } });
    assert.deepEqual(c.inherited.map(x => x.legId), [hash(2), hash(3)]);
    assert.equal(prepare(completed, c, f).next.legs[0]!.outcome, 'completed');
  });
  test('no aliases into source, consent, facts or effects', () => {
    const s = empty(); const { c, f } = forward(s); const before = structuredClone(s);
    Object.freeze(s); Object.freeze(c); Object.freeze(f);
    const p = prepare(s, c, f);
    assert.deepEqual(s, before);
    assert.notEqual(p.next.domain, s.domain);
    assert.notEqual(p.next.initial, s.initial);
    assert.notEqual(p.next.legs[0]!.buyer, c.leg.buyer);
    assert.notEqual(p.effects[0]!.to, p.next.legs[0]!.buyer);
  });
  test('repeated accounts do not collapse the accepted occurrences', () => {
    let s = empty(); let pair = forward(s); s = prepare(s, pair.c, pair.f).next;
    pair = forward(s, { ...leg(2), buyer: { occurrenceId: hash(102), account: s.initial.account } });
    s = prepare(s, pair.c, pair.f).next;
    const c = command(s, { kind: 'complete-prefix', throughLegId: hash(1) });
    refused(() => prepare(s, c, completion(s, 0, 2)), 'CONTROL_DUAL_POSITION_REQUIRED');
    assert.equal(prepare(s, c, completion(s, 2, 2)).next.legs[0]!.outcome, 'completed');
  });
});

describe('accepted callback, detached boundary and bounded reverse recovery', () => {
  test('D -> C -> B -> A; request alone emits no transfer and no returned outcome', () => {
    const s = chain(); const requested = begin(s);
    assert.deepEqual(requested.effects, []);
    assert(requested.next.legs.every(l => l.outcome === 'returning'));
    let next = requested.next;
    for (const n of [3, 2, 1]) {
      const p = hop(next, n);
      assert.equal(p.effects.length, 1);
      assert.equal(p.effects[0]!.from.account, account(4 - n));
      assert.equal(p.effects[0]!.to.account, account(5 - n));
      // Model-only serialized round trip, not proof of durable chain execution.
      next = structuredClone(p.next);
    }
    assert.equal(next.callback, null);
    assert(next.legs.every(l => l.outcome === 'returned'));
    refused(() => begin(next), 'CONTROL_RETURN_BOUNDARY_REFUSED');
    refused(() => hop(next, 1), 'CONTROL_CALLBACK_REQUIRED');
  });
  test('AB completion permanently stops BC callback at B', () => {
    const s = chain();
    let next = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(1) }), completion(s, 1)).next;
    refused(() => begin(next, 1), 'CONTROL_RETURN_BOUNDARY_REFUSED');
    next = begin(next, 2).next;
    next = hop(next, 3, 2).next;
    const last = hop(next, 2, 2);
    assert.equal(last.effects[0]!.to.account, account(3));
    assert.deepEqual(last.next.legs.map(l => l.outcome), ['completed', 'returned', 'returned']);
    refused(() => begin(last.next, 1), 'CONTROL_RETURN_BOUNDARY_REFUSED');
  });
  test('a shorter callback preserves an earlier active obligation for later completion', () => {
    let s = begin(chain(), 2).next;
    s = hop(s, 3, 2).next; s = hop(s, 2, 2).next;
    const p = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(1) }), completion(s, 1, 1));
    assert.deepEqual(p.next.legs.map(l => l.outcome), ['completed', 'returned', 'returned']);
  });
  test('a shorter callback can continue earlier without reviving returned legs', () => {
    let s = begin(chain(), 2).next;
    s = hop(s, 3, 2).next; s = hop(s, 2, 2).next;
    s = begin(s, 1).next;
    assert.deepEqual(s.legs.map(l => l.outcome), ['returning', 'returned', 'returned']);
    assert.equal(hop(s, 1).effects[0]!.to.account, account(4));
  });
  test('wrong authority, trigger, out-of-order hop and late completion are refused', () => {
    const s = chain(); const c = command(s, { kind: 'begin-return', rootLegId: hash(1) });
    refused(() => prepare(s, c, facts(s)), 'CONTROL_RETURN_AUTHORITY_REFUSED');
    refused(() => prepare(s, c, facts(s, { actor: account(81) })), 'CONTROL_RETURN_CONDITION_REFUSED');
    const r = begin(s).next;
    refused(() => hop(r, 1), 'CONTROL_RETURN_ORDER_REFUSED');
    refused(() => prepare(r, command(r, { kind: 'complete-prefix', throughLegId: hash(1) }), completion(r, 3)), 'CONTROL_CALLBACK_ACTIVE');
    const pair = forward(r);
    refused(() => prepare(r, pair.c, pair.f), 'CONTROL_CALLBACK_ACTIVE');
    refused(() => hop(r, 3, 2), 'CONTROL_RETURN_AUTHORITY_REFUSED');
  });
  test('existing sequence cannot silently forward past returned history', () => {
    let s = begin(chain()).next;
    for (const n of [3, 2, 1]) s = hop(s, n).next;
    const pair = forward(s);
    refused(() => prepare(s, pair.c, pair.f), 'CONTROL_SEQUENCE_RESTART_REQUIRED');
  });
});

describe('domain, consent, replay and concurrency gates', () => {
  for (const field of ['chainId', 'token', 'tokenId', 'sequenceId', 'controlId'] as const) {
    test(`reject substituted domain ${field}`, () => {
      const s = empty(); const { c, f } = forward(s);
      const domain = { ...s.domain, [field]: typeof s.domain[field] === 'bigint' ? 99n : hash(888) };
      refused(() => prepare(s, { ...c, domain }, f), 'CONTROL_DOMAIN_MISMATCH');
      refused(() => prepare(s, c, { ...f, domain }), 'CONTROL_FACTS_BINDING_REFUSED');
      refused(() => prepare(s, c, { ...f, recipientAcceptance: { ...c, domain } }), 'CONTROL_RECIPIENT_ACCEPTANCE_REQUIRED');
    });
  }
  test('missing acceptance and forged accepted terms/authority are refused structurally', () => {
    const s = empty(); const { c, f } = forward(s);
    refused(() => prepare(s, c, facts(s)), 'CONTROL_RECIPIENT_ACCEPTANCE_REQUIRED');
    for (const delta of [{ termsHash: hash(999) }, { returnAuthority: account(999) },
      { returnConditionHash: hash(999) }, { acceptanceHash: hash(999) }, { id: hash(999) },
      { buyer: { occurrenceId: hash(999), account: account(3) } },
      { buyer: { occurrenceId: hash(101), account: account(999) } }]) {
      refused(() => prepare(s, { ...c, leg: { ...c.leg, ...delta } }, f), 'CONTROL_RECIPIENT_ACCEPTANCE_REQUIRED');
    }
  });
  test('inherited omission, reordering and terms substitution are refused even if both claims agree', () => {
    const s = chain(); const { c, f } = forward(s, { ...leg(3), id: hash(4), acceptanceHash: hash(304),
      buyer: { occurrenceId: hash(104), account: account(7) } });
    for (const inherited of [[], c.inherited.slice().reverse(),
      c.inherited.map((x, i) => i === 0 ? { ...x, termsHash: hash(999) } : x)]) {
      const changed = { ...c, inherited };
      refused(() => prepare(s, changed, { ...f, recipientAcceptance: changed }), 'CONTROL_INHERITANCE_REFUSED');
    }
  });
  test('stale command and stale facts are not retried against a newer state', () => {
    const s = empty(); const { c, f } = forward(s); const p = prepare(s, c, f);
    refused(() => prepare(p.next, c, f), 'CONTROL_STALE_REVISION');
    const next = forward(p.next);
    refused(() => prepare(p.next, next.c, { ...next.f, expectedRevision: 0n }), 'CONTROL_FACTS_BINDING_REFUSED');
  });
  test('completion vs callback and head completion vs tail forwarding require a fresh revision', () => {
    const s = chain(); const complete = command(s, { kind: 'complete-prefix', throughLegId: hash(1) });
    const completed = prepare(s, complete, completion(s, 1));
    const callback = command(s, { kind: 'begin-return', rootLegId: hash(1) });
    refused(() => prepare(completed.next, callback, facts(s)), 'CONTROL_STALE_REVISION');
    const tail = forward(s, { ...leg(3), id: hash(4), acceptanceHash: hash(304), buyer: { occurrenceId: hash(104), account: account(7) } });
    refused(() => prepare(completed.next, tail.c, tail.f), 'CONTROL_STALE_REVISION');
    const returned = begin(s);
    refused(() => prepare(returned.next, complete, completion(s, 1)), 'CONTROL_STALE_REVISION');
  });
  test('owner-only, missing evidence and mismatched occurrence cannot complete', () => {
    const s = chain(); const c = command(s, { kind: 'complete-prefix', throughLegId: hash(1) });
    refused(() => prepare(s, c, facts(s)), 'CONTROL_COMPLETION_EVIDENCE_REQUIRED');
    refused(() => prepare(s, c, completion(s, 0)), 'CONTROL_DUAL_POSITION_REQUIRED');
    refused(() => prepare(s, c, completion(s, 3, 0)), 'CONTROL_OWNER_STATE_MISMATCH');
    const f = completion(s, 1);
    refused(() => prepare(s, c, { ...f, completion: { ...f.completion!, admittedHolder: { occurrenceId: hash(777), account: account(3) } } }), 'CONTROL_EVIDENCE_OCCURRENCE_REFUSED');
  });
  test('revision overflow and unknown action fail closed', () => {
    const s = { ...empty(), revision: (1n << 256n) - 1n }; const { c, f } = forward(s);
    refused(() => prepare(s, c, f), 'CONTROL_REVISION_EXHAUSTED');
    refused(() => prepare(empty(), command(empty(), { kind: 'withdraw-all' }), facts(empty())), 'CONTROL_COMMAND_REFUSED');
  });
  test('reused leg, acceptance and occurrence cannot overwrite history', () => {
    const s = chain();
    for (const changed of [leg(1), { ...leg(3), id: hash(4) },
      { ...leg(3), id: hash(4), acceptanceHash: hash(304) }]) {
      const pair = forward(s, changed);
      assert.throws(() => prepare(s, pair.c, pair.f), ResponsibilityControlError);
    }
  });
  test('failed effect leaves original state untouched; this kernel does not claim a receipt', () => {
    const s = begin(chain()).next; const original = structuredClone(s); const p = hop(s, 3);
    // Simulate executor refusing token transfer. Do NOT persist proposal.next.
    assert.equal(p.status, 'UNCOMMITTED_PROPOSAL');
    assert.deepEqual(s, original);
    assert.deepEqual(hop(s, 3), p); // deterministic proposal, not duplicate executed transfer
  });
});

describe('the active window, not the retained history', () => {
  // The shared leg() helper derives account(4 - n), which runs out past the
  // fourth leg. A rolling chain needs a builder that scales.
  const longLeg = (n: number): ResponsibilityLeg => ({
    id: hash(10_000 + n), buyer: { occurrenceId: hash(20_000 + n), account: account(1_000 + n) },
    termsHash: hash(30_000 + n), acceptanceHash: hash(40_000 + n),
    returnAuthority: account(2_000 + n), returnConditionHash: hash(50_000 + n), outcome: 'active',
  });

  /** Forward, then detach the head: what a token that keeps trading looks like. */
  function rolled(hops: number): ResponsibilityState {
    let s = empty();
    for (let i = 0; i < hops; i++) {
      const step = forward(s, longLeg(i + 1));
      s = prepare(s, step.c, step.f).next;
      s = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(10_000 + i + 1) }),
        completion(s, i + 1, i + 1)).next;
    }
    return s;
  }

  test('a chain longer than the window keeps forwarding', () => {
    const s = rolled(140);
    assert.equal(s.legs.length, 140, 'history is retained in full');
    assert.equal(s.legs.filter(l => l.outcome === 'active').length, 0, 'nothing unresolved');
    // Past the window by history, and still able to move. This is the property:
    // how much a token has already traded never stops the next trade.
    const step = forward(s, longLeg(141));
    assert.equal(prepare(s, step.c, step.f).next.legs.length, 141);
  });

  test('the window itself is enforced on the unresolved tail', () => {
    let s = empty();
    for (let i = 0; i < 128; i++) {
      const step = forward(s, longLeg(i + 1));
      s = prepare(s, step.c, step.f).next;
    }
    assert.equal(s.legs.filter(l => l.outcome === 'active').length, 128);
    const blocked = forward(s, longLeg(129));
    refused(() => prepare(s, blocked.c, blocked.f), 'CONTROL_ACTIVE_LEG_LIMIT');

    // Detaching one head frees exactly one slot, and it moves again.
    const detached = prepare(s, command(s, { kind: 'complete-prefix', throughLegId: hash(10_001) }),
      completion(s, 1, 128)).next;
    const again = forward(detached, longLeg(129));
    const next = prepare(detached, again.c, again.f).next;
    assert.equal(next.legs.filter(l => l.outcome === 'active').length, 128, 'still full, never over');
    assert.equal(next.legs.length, 129, 'history grew past the window');
  });

  test('the kernel window equals the contract window', async () => {
    // A kernel that allowed more would hand the execution adapter a proposal the
    // chain refuses, which is how the two drifted 4096 against 128 before.
    const { readFileSync } = await import('node:fs');
    const solidity = readFileSync('contracts/controls/ResponsibilityController.sol', 'utf8');
    assert.equal(/MAX_ACTIVE_LEGS\s*=\s*(\d+)/.exec(solidity)?.[1], '128');
  });
});
