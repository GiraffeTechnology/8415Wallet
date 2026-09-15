import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  CAROL,
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  STRANGER,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  confirmingEntryToken,
  divergentToken,
  projectionOnlyToken,
} from '../src/adapters/memory/scenarios.ts';
import { NonConformantContractError, ProjectionNotInitialized } from '../src/sdk/errors.ts';
import type { Erc8415Reader } from '../src/sdk/port.ts';
import { buildAssetView } from '../src/wallet/assetView.ts';
import { renderAssetView } from '../src/wallet/renderAssetView.ts';

describe('the two sequences are kept apart', () => {
  test('both are reported, and they differ', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.tradeablePosition.owner, DAVE);
    assert.equal(view.confirmedHolder.holder, ALICE);
    assert.equal(view.alignment.aligned, false);
  });

  test('divergence is reported as the design, not as an error', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.match(view.alignment.note, /not a fault/);
    // And the rest of the view is fully populated: nothing degrades.
    assert.equal(view.confirmedHolder.entryCount, 3n);
    assert.equal(view.gap.kind, 'open');
  });

  test('alignment is reported without merging the two facts', async () => {
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, ALICE);
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.alignment.aligned, true);
    // Agreement now does not make them one field, and the disclosures stay.
    assert.notEqual(view.tradeablePosition.disclosure, view.confirmedHolder.disclosure);
    assert.match(view.alignment.note, /two separate facts/);
  });

  test('carries the entry that admitted the holder, and an opaque reference', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.confirmedHolder.version, 3n);
    assert.equal(view.confirmedHolder.effectiveAt, T.v3);
    assert.equal(view.confirmedHolder.recordCommitment, commitment('c'));
    assert.equal(view.confirmedHolder.previousCommitment, commitment('b'));
    // A reference is not a commitment, and is never resolved to content.
    assert.notEqual(view.confirmedHolder.registryReference, view.confirmedHolder.recordCommitment);
  });
});

describe('finality of the present', () => {
  test('is read from isFinalAsOf, and the present is provisional', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.presentFinality.final, false);
    assert.equal(view.presentFinality.instant, view.observedAt);
    assert.equal(view.presentFinality.latestEffectiveAt, T.v3);
    assert.match(view.presentFinality.explanation, /confirming entry/);
  });

  test('stays provisional after a gap closes by admission', async () => {
    const { contract, reader } = divergentToken();
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });
    contract.advanceTo(T.later);

    const view = await buildAssetView(reader, TOKEN);
    assert.equal(view.gap.kind, 'none');
    // The gap closed and the holder moved, and the present is still not final.
    assert.equal(view.confirmedHolder.holder, DAVE);
    assert.equal(view.presentFinality.final, false);
  });

  test('flags a contract that reports the present as final', async () => {
    // The finality rule forbids it. If a contract says otherwise, the wallet
    // reports what it was told and says the answer is not to be trusted —
    // rather than quietly substituting the rule's answer.
    const { reader } = divergentToken();
    const lying: Erc8415Reader = {
      source: reader.source,
      chainInstant: () => reader.chainInstant(),
      supportsInterface: (id) => reader.supportsInterface(id),
      ownerOf: (id) => reader.ownerOf(id),
      currentEntry: (id) => reader.currentEntry(id),
      entryAt: (id, version) => reader.entryAt(id, version),
      entryAsOf: (id, instant) => reader.entryAsOf(id, instant),
      holderAsOf: (id, instant) => reader.holderAsOf(id, instant),
      entryCount: (id) => reader.entryCount(id),
      registerId: () => reader.registerId(),
      settlement: (id) => reader.settlement(id),
      openGapOf: (id) => reader.openGapOf(id),
      settlementPeriod: () => reader.settlementPeriod(),
      verificationProfile: () => reader.verificationProfile(),
      isSettlementAuthority: (id, account) => reader.isSettlementAuthority(id, account),
      isFinalAsOf: async () => true,
    };

    const view = await buildAssetView(lying, TOKEN);
    assert.equal(view.presentFinality.final, true);
    assert.match(view.presentFinality.explanation, /does not allow/);
  });
});

describe('gap state', () => {
  test('an open gap carries its deadline, contested boundary and remaining time', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.gap.kind, 'open');
    if (view.gap.kind !== 'open') return;
    assert.equal(view.gap.settlementId, OPEN_GAP_ID);
    assert.equal(view.gap.openedAt, T.openGapOpened);
    assert.equal(view.gap.contestedFrom, T.openGapOpened);
    assert.equal(view.gap.deadline, T.openGapDeadline);
    assert.equal(view.gap.timeRemaining, T.openGapDeadline - T.asOf);
    assert.equal(view.gap.cancellable, false);
    assert.equal(view.gap.expectedHolder, DAVE);
  });

  test('a passed deadline shows negative remaining time and becomes cancellable', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 3_600n);

    const view = await buildAssetView(reader, TOKEN);
    assert.equal(view.gap.kind, 'open');
    if (view.gap.kind !== 'open') return;
    assert.equal(view.gap.timeRemaining, -3_600n);
    assert.equal(view.gap.cancellable, true);
  });

  test('a closed gap reads as none, not as settled', async () => {
    const { reader } = cancelledGapToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.gap.kind, 'none');
    assert.equal(view.presentFinality.final, false);
  });

  test('no settlement interface is distinguished from no open gap', async () => {
    const withInterface = await buildAssetView(cancelledGapToken().reader, TOKEN);
    const without = await buildAssetView(projectionOnlyToken().reader, TOKEN);

    assert.equal(withInterface.gap.kind, 'none');
    assert.equal(without.gap.kind, 'unsupported');
    assert.match(without.gap.note, /property of the contract/);
  });
});

describe('settlement authority', () => {
  test('reports the registrar and not the owner', async () => {
    const { reader } = divergentToken();

    const asRegistrar = await buildAssetView(reader, TOKEN, { account: REGISTRAR });
    assert.equal(asRegistrar.authority.authorized, true);

    const asOwner = await buildAssetView(reader, TOKEN, { account: DAVE });
    assert.equal(asOwner.authority.authorized, false);
    assert.match(asOwner.authority.note, /does not confer the authority/);
  });

  test('reports nothing rather than false when no account is supplied', async () => {
    const { reader } = divergentToken();
    const view = await buildAssetView(reader, TOKEN);

    assert.equal(view.authority.account, undefined);
    assert.equal(view.authority.authorized, undefined);
  });

  test('reports nothing rather than false when there is no interface to ask', async () => {
    // "Cannot be asked" is not "answered no". Collapsing the two would tell a
    // user the contract denied them an authority it has no concept of.
    const view = await buildAssetView(projectionOnlyToken().reader, TOKEN, { account: STRANGER });
    assert.equal(view.authority.authorized, undefined);

    const rendered = renderAssetView(view);
    assert.match(rendered, /May open a gap\s+not reported/);
    assert.doesNotMatch(rendered, /May open a gap\s+no$/m);
  });
});

describe('gating and failure', () => {
  test('refuses a contract that does not advertise the projection', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      conformance: { projection: false },
    });
    contract.mint(TOKEN, ALICE);
    contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);

    await assert.rejects(
      () => buildAssetView(new MemoryErc8415Reader(contract), TOKEN),
      NonConformantContractError,
    );
  });

  test('says the projection is uninitialized rather than showing the position as the record', async () => {
    const contract = new MemoryRegisterContract({ now: T.v1 });
    contract.mint(TOKEN, ALICE);

    await assert.rejects(
      () => buildAssetView(new MemoryErc8415Reader(contract), TOKEN),
      ProjectionNotInitialized,
    );
  });
});

describe('rendering', () => {
  test('shows both addresses in full and never abbreviates them', async () => {
    const { reader } = divergentToken();
    const rendered = renderAssetView(await buildAssetView(reader, TOKEN, { account: REGISTRAR }));

    assert.ok(rendered.includes(DAVE), 'the position address is shown in full');
    assert.ok(rendered.includes(ALICE), 'the holder address is shown in full');
  });

  test('every rendered instant carries its integer', async () => {
    const { reader } = divergentToken();
    const rendered = renderAssetView(await buildAssetView(reader, TOKEN, { account: REGISTRAR }));

    // A calendar time must always be followed by its integer in parentheses.
    const bare = rendered.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC(?! \(\d+\))/g) ?? [];
    assert.deepEqual(bare, [], 'a formatted instant appeared without its integer');
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(\d+\)/.test(rendered));
    assert.ok(rendered.includes(`(${T.asOf})`));
  });

  test('keeps finality, contest and conformance in separate blocks', async () => {
    const { reader } = divergentToken();
    const rendered = renderAssetView(await buildAssetView(reader, TOKEN, { account: REGISTRAR }));

    assert.ok(rendered.includes('FINALITY OF THE PRESENT  ·  Provisional'));
    assert.ok(rendered.includes('SETTLEMENT GAP  ·  open'));
    assert.ok(rendered.includes('Contested from'));
    assert.ok(rendered.includes('projection 0x6309e170'));
  });

  test('renders a token whose holder never changed', async () => {
    const { reader } = confirmingEntryToken();
    const view = await buildAssetView(reader, TOKEN);
    assert.equal(view.confirmedHolder.holder, ALICE);
    assert.ok(renderAssetView(view).includes('CONFIRMED HOLDER'));
  });

  test('renders a projection-only contract without inventing a profile', async () => {
    const rendered = renderAssetView(await buildAssetView(projectionOnlyToken().reader, TOKEN));
    assert.match(rendered, /Profile\s+none — no settlement interface/);
    assert.match(rendered, /settlement absent/);
    assert.ok(rendered.includes(CAROL));
  });
});
