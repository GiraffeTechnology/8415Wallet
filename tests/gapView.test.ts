import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CANCELLED_GAP_ID,
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  divergentToken,
  projectionOnlyToken,
  settlementId,
} from '../src/adapters/memory/scenarios.ts';
import { buildRiskSurfaces } from '../src/wallet/riskSurfaces.ts';
import { buildSettlementLog } from '../src/wallet/settlementLog.ts';
import { buildTemporalView } from '../src/wallet/temporalQuery.ts';
import { renderRiskSurfaces, renderSettlementLog } from '../src/wallet/renderGapView.ts';
import { renderTemporalQuery } from '../src/wallet/renderTemporalQuery.ts';
import { delegateReader } from './support/delegateReader.ts';

describe('the settlement log shows what the entry walk cannot', () => {
  test('a cancelled gap appears, though it admitted nothing', async () => {
    const { reader } = cancelledGapToken();
    const view = await buildSettlementLog(reader, TOKEN);

    const cancelled = view.episodes.find((item) => item.settlementId === CANCELLED_GAP_ID);
    assert.notEqual(cancelled, undefined);
    assert.equal(cancelled?.closure, 'cancelled');
    assert.match(cancelled?.meaning ?? '', /nothing settled/);
    assert.match(cancelled?.meaning ?? '', /not a rejection/);

    // And it left no entry behind, which is the point.
    assert.equal(await reader.entryCount(TOKEN), 2n);
  });

  test('a superseded gap is distinguished from a cancelled one', async () => {
    const { contract, reader } = divergentToken();
    contract.beginSettlement(
      REGISTRAR,
      TOKEN,
      settlementId('9'),
      DAVE,
      commitment('5'),
      contract.now + 600n,
    );

    const view = await buildSettlementLog(reader, TOKEN);
    const superseded = view.episodes.find((item) => item.settlementId === OPEN_GAP_ID);
    assert.equal(superseded?.closure, 'superseded');
    assert.equal(superseded?.replacedBy, settlementId('9'));
    assert.match(superseded?.meaning ?? '', /proof already produced .* now unusable/);
  });

  test('an admitted gap names the entry it appended', async () => {
    const { contract, reader } = divergentToken();
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });

    const view = await buildSettlementLog(reader, TOKEN);
    const admitted = view.episodes.find((item) => item.settlementId === OPEN_GAP_ID);
    assert.equal(admitted?.closure, 'admitted');
    assert.equal(admitted?.admitted?.version, 4n);
    assert.equal(admitted?.admitted?.effectiveAt, T.asOf + 1n);
  });

  test('openedAt comes from the settlement record, not from the log', async () => {
    // SettlementStarted does not carry it; it is the block timestamp at which
    // beginSettlement succeeded, and it bounds the contested interval.
    const { reader } = divergentToken();
    const view = await buildSettlementLog(reader, TOKEN);
    const open = view.episodes.find((item) => item.settlementId === OPEN_GAP_ID);

    assert.equal(open?.openedAt, T.openGapOpened);
    assert.equal(open?.closure, 'still-open');
  });

  test('a reader without logs says so instead of returning an empty history', async () => {
    const { reader } = cancelledGapToken();
    const { getLogs: _omitted, ...withoutLogs } = delegateReader(reader, {});

    const view = await buildSettlementLog(withoutLogs, TOKEN);
    assert.equal(view.available, false);
    assert.deepEqual(view.episodes, []);
    assert.match(view.note, /not evidence that none occurred/);
    assert.match(renderSettlementLog(view), /not evidence that none occurred/);
  });
});

describe('contest is a separate signal from finality', () => {
  test('an instant after the gap opened is contested and provisional', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.asOf);

    assert.equal(view.contest.display, 'contested');
    assert.equal(view.finality.display, 'provisional');
    assert.equal(view.contest.openedAt, T.openGapOpened);
  });

  test('an instant before the gap opened is not contested, though a gap is open', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.v2);

    assert.equal(view.contest.display, 'not-contested');
    assert.match(view.contest.explanation, /bounded by the gap/);
  });

  test('a final instant can sit under an open gap', async () => {
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.finalInstant);

    // Finality does not depend on whether a gap is open.
    assert.equal(view.finality.display, 'final');
    assert.equal(view.contest.display, 'not-contested');
  });

  test('closing a gap ends the contest without settling anything', async () => {
    const { contract, reader } = cancelledGapToken();
    // The cancelled gap is closed; nothing is contested, and the instants at
    // or after the latest entry are still not final.
    const view = await buildTemporalView(reader, TOKEN, contract.now);

    assert.equal(view.contest.display, 'not-contested');
    assert.equal(view.finality.display, 'provisional');
    assert.match(view.contest.explanation, /not a statement about finality/);
  });

  test('a contract with no settlement interface has no contested instants', async () => {
    const view = await buildTemporalView(projectionOnlyToken().reader, TOKEN, T.asOf);

    assert.equal(view.contest.display, 'no-gap-interface');
    assert.match(view.contest.explanation, /no gaps and no contested instants/);
    // And that says nothing about finality.
    assert.equal(view.finality.display, 'provisional');
  });

  test('the two are rendered as separate blocks', async () => {
    const { reader } = divergentToken();
    const rendered = renderTemporalQuery(await buildTemporalView(reader, TOKEN, T.asOf));

    assert.match(rendered, /FINALITY {2}· {2}Provisional/);
    assert.match(rendered, /CONTEST {2}· {2}Contested/);
    assert.ok(rendered.indexOf('FINALITY') < rendered.indexOf('CONTEST'));
  });
});

describe('risk surfaces', () => {
  test('report every surface in PRD §4.6', async () => {
    const { reader } = divergentToken();
    const view = await buildRiskSurfaces(reader, TOKEN, { account: REGISTRAR });

    assert.deepEqual(
      view.surfaces.map((surface) => surface.id),
      [
        'stalled-register',
        'held-open-gap',
        'authority-scope',
        'profile-acceptance',
        'far-future-effective-time',
      ],
    );
  });

  test('state findings as measurements, and never as a verdict', async () => {
    const { reader } = divergentToken();
    const view = await buildRiskSurfaces(reader, TOKEN, { account: REGISTRAR });

    // The note is the wallet stating what it will not do, so it is exempt: it
    // is the only place these words may legitimately appear.
    assert.match(view.note, /does not score these/);
    assert.match(view.note, /safe or unsafe verdict/);

    const text = view.surfaces
      .map((surface) => `${surface.heading} ${surface.finding} ${surface.meaning}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['safe to', 'unsafe', 'recommend', 'you should', 'warning:', 'danger']) {
      assert.ok(!text.includes(word), `a risk surface produced a verdict: ${word}`);
    }
    assert.ok(renderRiskSurfaces(view).includes(view.note.slice(0, 20)));
  });

  test('count supersessions, and say so when logs cannot be read', async () => {
    const { contract, reader } = divergentToken();
    for (let round = 0; round < 2; round += 1) {
      contract.advanceTo(contract.now + 60n);
      contract.beginSettlement(
        REGISTRAR,
        TOKEN,
        commitment(`${round + 1}`),
        DAVE,
        commitment('5'),
        contract.now + 600n,
      );
    }

    const view = await buildRiskSurfaces(reader, TOKEN, { account: REGISTRAR });
    const held = view.surfaces.find((surface) => surface.id === 'held-open-gap');
    assert.equal(held?.present, true);
    assert.match(held?.finding ?? '', /2 settlement\(s\)/);

    const { getLogs: _omitted, ...withoutLogs } = delegateReader(reader, {});
    const blind = await buildRiskSurfaces(withoutLogs, TOKEN, { account: REGISTRAR });
    const blindHeld = blind.surfaces.find((surface) => surface.id === 'held-open-gap');
    assert.match(blindHeld?.finding ?? '', /not a count of zero/);
  });

  test('flag a far-future effective time only when one is present', async () => {
    const { reader } = divergentToken();
    const near = await buildRiskSurfaces(reader, TOKEN);
    assert.equal(
      near.surfaces.find((surface) => surface.id === 'far-future-effective-time')?.present,
      false,
    );

    const { contract, reader: reader2 } = divergentToken();
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      // Ten years out: no later entry can ever exceed it.
      effectiveAt: T.asOf + 10n * 365n * 24n * 60n * 60n,
      proofData: '0x',
    });
    const far = await buildRiskSurfaces(reader2, TOKEN);
    const surface = far.surfaces.find((item) => item.id === 'far-future-effective-time');
    assert.equal(surface?.present, true);
    assert.match(surface?.meaning ?? '', /permanently ends the projection/);
  });

  test('report authority without approving it', async () => {
    const { reader } = divergentToken();
    const view = await buildRiskSurfaces(reader, TOKEN, { account: DAVE });
    const authority = view.surfaces.find((surface) => surface.id === 'authority-scope');

    assert.match(authority?.finding ?? '', /reports false/);
    assert.match(authority?.meaning ?? '', /Reading who holds it is not approving them/);
  });

  test('say when no profile can be identified', async () => {
    const view = await buildRiskSurfaces(projectionOnlyToken().reader, TOKEN);
    const profile = view.surfaces.find((surface) => surface.id === 'profile-acceptance');
    assert.match(profile?.finding ?? '', /names no verification profile/);
  });
});
