import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  CAROL,
  DAVE,
  OPEN_GAP_ID,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  confirmingEntryToken,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import { ContractRevertError, ProjectionNotInitialized } from '../src/sdk/errors.ts';
import { buildTemporalView } from '../src/wallet/temporalQuery.ts';
import { renderTemporalQuery } from '../src/wallet/renderTemporalQuery.ts';
import { delegateReader } from './support/delegateReader.ts';

describe('resolution', () => {
  test('resolves the covering entry inside an interval', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.finalInstant);

    assert.equal(view.resolution.kind, 'resolved');
    if (view.resolution.kind !== 'resolved') return;
    assert.equal(view.resolution.holder, CAROL);
    assert.equal(view.resolution.entry.version, 2n);
    assert.equal(view.resolution.holderAgreesWithEntry, true);
  });

  test('carries the interval, closed at the successor', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.finalInstant);

    assert.equal(view.resolution.kind, 'resolved');
    if (view.resolution.kind !== 'resolved') return;
    assert.equal(view.resolution.interval.from, T.v2);
    assert.equal(view.resolution.interval.until, T.v3);
  });

  test('leaves the latest entry’s interval open', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.asOf);

    assert.equal(view.resolution.kind, 'resolved');
    if (view.resolution.kind !== 'resolved') return;
    assert.equal(view.resolution.interval.from, T.v3);
    assert.equal(view.resolution.interval.until, undefined);
  });

  test('an instant before the first entry is not covered, and is not an error', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.beforeFirstEntry);

    assert.equal(view.resolution.kind, 'not-covered');
    if (view.resolution.kind !== 'not-covered') return;
    assert.equal(view.resolution.firstEffectiveAt, T.v1);
    assert.match(view.resolution.note, /not a fault/);
    // Not an answer of "no holder" either.
    assert.match(view.resolution.note, /says nothing about this instant/);
  });

  test('surfaces a disagreement between holderAsOf and entryAsOf', async () => {
    const { reader } = divergentToken();
    const inconsistent = delegateReader(reader, { holderAsOf: async () => DAVE });

    const view = await buildTemporalView(inconsistent, TOKEN, T.asOf);
    assert.equal(view.resolution.kind, 'resolved');
    if (view.resolution.kind !== 'resolved') return;
    assert.equal(view.resolution.holderAgreesWithEntry, false);
    // Collapse the renderer's line wrapping before matching prose.
    const flat = renderTemporalQuery(view).replace(/\s+/g, ' ');
    assert.match(flat, /requires these to agree/);
    assert.match(flat, /neither answer should be relied on/);
  });
});

describe('a read the wallet cannot attribute', () => {
  test('is reported as unavailable, not as not-covered', async () => {
    const { reader } = divergentToken();
    // A revert at an instant the projection does covers: the cause is not
    // something the wallet can establish, so it does not claim one.
    const failing = delegateReader(reader, {
      entryAsOf: async () => {
        throw new ContractRevertError('entryAsOf: node unavailable');
      },
    });

    const view = await buildTemporalView(failing, TOKEN, T.asOf);
    assert.equal(view.resolution.kind, 'unavailable');
    if (view.resolution.kind !== 'unavailable') return;
    assert.match(view.resolution.reason, /node unavailable/);
  });

  test('never substitutes ownerOf, a cached answer or a neighbouring instant', async () => {
    const { reader } = divergentToken();
    const failing = delegateReader(reader, {
      entryAsOf: async () => {
        throw new ContractRevertError('entryAsOf: reverted');
      },
    });

    const view = await buildTemporalView(failing, TOKEN, T.asOf);
    const rendered = renderTemporalQuery(view);

    assert.equal(view.resolution.kind, 'unavailable');
    assert.match(rendered, /Holder\s+unavailable/);
    // The position is still shown, under its own heading, as contrast only.
    assert.match(rendered, /TRADEABLE POSITION \(for contrast, not the answer\)/);
    assert.match(view.resolution.kind === 'unavailable' ? view.resolution.note : '', /No neighbouring/);
  });

  test('a finality read that fails does not become an answer', async () => {
    const { reader } = divergentToken();
    const failing = delegateReader(reader, {
      isFinalAsOf: async () => {
        throw new ContractRevertError('isFinalAsOf: transport fault');
      },
    });

    const view = await buildTemporalView(failing, TOKEN, T.finalInstant);
    assert.equal(view.finality.reported, undefined);
    assert.equal(view.finality.display, 'unavailable');
    assert.match(view.finality.explanation, /does not guess/);
    // Resolution is independent and still succeeds.
    assert.equal(view.resolution.kind, 'resolved');
  });
});

describe('finality display', () => {
  test('final strictly before the latest entry', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.finalInstant);

    assert.equal(view.finality.reported, true);
    assert.equal(view.finality.display, 'final');
    assert.match(view.finality.explanation, /not legal finality/);
  });

  test('provisional at and after the latest entry', async () => {
    const { reader } = divergentToken();
    for (const instant of [T.v3, T.asOf, T.later]) {
      const view = await buildTemporalView(reader, TOKEN, instant);
      assert.equal(view.finality.display, 'provisional', `at ${instant}`);
      assert.match(view.finality.explanation, /confirming entry/);
    }
  });

  test('not-covered before the first entry, distinct from provisional', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.beforeFirstEntry);

    // isFinalAsOf answers false in both cases; the wallet does not render them
    // as the same thing, because nothing there is provisional — nothing
    // resolved at all.
    assert.equal(view.finality.reported, false);
    assert.equal(view.finality.display, 'not-covered');
    assert.notEqual(view.finality.display, 'provisional');
    assert.match(view.finality.explanation, /without reverting/);
  });

  test('a confirming entry moves an instant from provisional to final', async () => {
    const before = await buildTemporalView(divergentToken().reader, TOKEN, T.asOf);
    assert.equal(before.finality.display, 'provisional');

    const { contract, reader } = divergentToken();
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });

    const after = await buildTemporalView(reader, TOKEN, T.asOf);
    assert.equal(after.finality.display, 'final');
    // The holder at that instant did not change; only its finality did.
    assert.deepEqual(
      after.resolution.kind === 'resolved' ? after.resolution.holder : undefined,
      before.resolution.kind === 'resolved' ? before.resolution.holder : undefined,
    );
  });

  test('a cancelled gap does not move an instant to final', async () => {
    const { reader } = cancelledGapToken();
    const view = await buildTemporalView(reader, TOKEN, T.asOf);
    assert.equal(view.finality.display, 'provisional');
  });

  test('flags an answer that contradicts the rule', async () => {
    const { reader } = divergentToken();
    const lying = delegateReader(reader, { isFinalAsOf: async () => true });

    const view = await buildTemporalView(lying, TOKEN, T.beforeFirstEntry);
    assert.equal(view.finality.display, 'final');
    assert.match(view.finality.explanation, /does not allow/);
  });
});

describe('the answer is never the position', () => {
  test('the position is shown apart and labelled as contrast', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.asOf);

    assert.equal(view.tradeablePosition.owner, DAVE);
    assert.equal(view.resolution.kind === 'resolved' ? view.resolution.holder : undefined, ALICE);
    assert.match(view.tradeablePosition.disclosure, /does not care who holds the token now/);
  });

  test('every rendered instant carries its integer', async () => {
    const { reader } = divergentToken();
    const rendered = renderTemporalQuery(await buildTemporalView(reader, TOKEN, T.finalInstant));
    const bare = rendered.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC(?! \(\d+\))/g) ?? [];
    assert.deepEqual(bare, []);
  });
});

describe('gating', () => {
  test('an uninitialized projection is reported, not resolved', async () => {
    const contract = new MemoryRegisterContract({ now: T.v1 });
    contract.mint(TOKEN, ALICE);

    await assert.rejects(
      () => buildTemporalView(new MemoryErc8415Reader(contract), TOKEN, T.v1),
      ProjectionNotInitialized,
    );
  });

  test('resolves a token whose holder never changed', async () => {
    const { reader } = confirmingEntryToken();
    const view = await buildTemporalView(reader, TOKEN, T.finalInstant);
    assert.equal(view.resolution.kind === 'resolved' ? view.resolution.holder : undefined, ALICE);
    assert.equal(view.finality.display, 'final');
  });
});
