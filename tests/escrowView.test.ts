import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildEscrowView } from '../src/wallet/escrowView.ts';
import { renderEscrow } from '../src/wallet/renderEscrow.ts';
import type { Trade, TradeObservation, TradeState } from '../src/sdk/escrow.ts';
import { ZERO_ADDRESS } from '../src/sdk/types.ts';

const SELLER = `0x${'5e'.repeat(20)}`;
const BUYER = `0x${'b0'.repeat(20)}`;
const ESCROW = `0x${'ec'.repeat(20)}`;
const NOW = 1_767_225_600n;
const DEADLINE = NOW + 3_600n;

const trade = (state: TradeState): Trade => ({
  projection: `0x${'ab'.repeat(20)}`,
  tokenId: 42n,
  seller: SELLER,
  buyer: BUYER,
  price: 3_000_000_000_000_000_000n,
  entryCountAtFunding: 1n,
  admissionDeadline: DEADLINE,
  maxEffectiveAt: NOW + 86_400n,
  state,
});

const observation = (over: Partial<TradeObservation> = {}): TradeObservation => ({
  state: 'FUNDED',
  confirmed: false,
  version: 0n,
  effectiveAt: 0n,
  confirmedHolder: SELLER,
  positionHolder: ESCROW,
  entryCount: 1n,
  ...over,
});

describe('a trade in flight', () => {
  test('a register that has not confirmed the buyer is the ordinary state, not a fault', () => {
    const view = buildEscrowView(trade('FUNDED'), observation(), NOW);
    assert.equal(view.state, 'waiting-for-the-register');
    assert.match(view.meaning, /rather than a sign of trouble/);
    // The two sequences are reported apart, and they differ here by design.
    assert.equal(view.positionHolder, ESCROW);
    assert.equal(view.confirmedHolder, SELLER);
    assert.notEqual(view.positionHolder, view.confirmedHolder);
  });

  test('nothing offers either party a way to hurry the register', () => {
    const view = buildEscrowView(trade('FUNDED'), observation(), NOW);
    assert.match(view.action, /this escrow has no authority over it/);
  });

  test('the deadline is counted down while the trade is live', () => {
    const view = buildEscrowView(trade('FUNDED'), observation(), NOW);
    assert.equal(view.window?.passed, false);
    assert.equal(view.window?.remaining, 3_600n);
  });
});

describe('what a confirmation does and does not mean', () => {
  test('a confirmed trade always carries the note that it is provisional', () => {
    const view = buildEscrowView(
      trade('FUNDED'),
      observation({ confirmed: true, version: 2n, effectiveAt: NOW - 60n, confirmedHolder: BUYER }),
      NOW,
    );
    assert.equal(view.state, 'confirmed');
    assert.notEqual(view.provisionalNote, undefined);
    assert.match(view.provisionalNote!, /final only once a later entry exists/);
    assert.equal(view.confirmingVersion, 2n);
  });

  test('a released trade still carries it, because releasing did not make it final', () => {
    const view = buildEscrowView(
      trade('RELEASED'),
      observation({ state: 'RELEASED', confirmed: true, version: 2n, confirmedHolder: BUYER, positionHolder: BUYER }),
      NOW,
    );
    assert.equal(view.state, 'released');
    assert.notEqual(view.provisionalNote, undefined);
  });

  test('no view claims the trade is final or settled', () => {
    for (const state of ['FUNDED', 'RELEASED', 'REFUNDED'] as const) {
      const view = buildEscrowView(trade(state), observation({ state }), NOW);
      const prose = `${view.headline} ${view.meaning} ${view.action}`;
      assert.doesNotMatch(prose, /\bis final\b|\bfinalised\b|\bfully settled\b|\bguaranteed\b/i);
    }
  });
});

describe('a deadline that passes', () => {
  test('is not read as anyone having been refused', () => {
    const view = buildEscrowView(trade('FUNDED'), observation(), DEADLINE + 1n);
    assert.equal(view.state, 'deadline-passed');
    // The protocol has no rejection, and a cancellation decides nothing.
    assert.match(view.meaning, /no rejection/);
    assert.match(view.meaning, /without deciding anything/);
  });

  test('a confirmation that lands late still outranks the clock', () => {
    const view = buildEscrowView(
      trade('FUNDED'),
      observation({ confirmed: true, version: 2n, confirmedHolder: BUYER }),
      DEADLINE + 10_000n,
    );
    assert.equal(view.state, 'confirmed');
    assert.match(view.action, /refuse if a confirmation lands first|Anyone may call release/);
  });
});

describe('rendering', () => {
  test('shows the position and the confirmed holder on separate lines', () => {
    const text = renderEscrow(buildEscrowView(trade('FUNDED'), observation(), NOW));
    assert.match(text, /Position sits with/);
    assert.match(text, /Register confirms/);
  });

  test('a price is printed exactly', () => {
    const odd = { ...trade('FUNDED'), price: 1_234_500_000_000_000_001n };
    const text = renderEscrow(buildEscrowView(odd, observation(), NOW));
    assert.match(text, /1\.234500000000000001 ETH/);
  });

  test('an empty register reads as no record, never as an address', () => {
    const text = renderEscrow(
      buildEscrowView(trade('FUNDED'), observation({ confirmedHolder: ZERO_ADDRESS }), NOW),
    );
    assert.match(text, /Register confirms\s+nobody — no record/);
    assert.ok(!text.includes(ZERO_ADDRESS));
  });
});
