import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  MemoryWatchtowerContract,
  MemoryWatchtowerReader,
} from '../src/adapters/memory/watchtower.ts';
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
  divergentToken,
  projectionOnlyToken,
} from '../src/adapters/memory/scenarios.ts';
import { noWatchtower, buildFreshnessView } from '../src/wallet/freshness.ts';
import { describeFinality } from '../src/wallet/finality.ts';
import { describePosture } from '../src/wallet/posture.ts';
import { detectCollisions } from '../src/wallet/collisions.ts';
import { WalletSession } from '../src/wallet/session.ts';
import {
  renderAcquisitionDisclosure,
  renderCollisions,
  renderPosture,
  renderRegistration,
} from '../src/wallet/renderHolderViews.ts';

describe('what a pending registration means to a holder', () => {
  test('an in-flight change behind the position says more transfers follow', async () => {
    // The gap admits Dave; the position is already Dave here, so level.
    // Move the position on, and the gap is now behind it.
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, STRANGER);

    const view = await new WalletSession(reader).registration(TOKEN);
    assert.equal(view.state, 'registering-with-more-behind');
    assert.equal(view.registering, DAVE);
    assert.equal(view.furtherHopsBehind, true);
    assert.match(view.meaning, /at least one more registration must follow/);
  });

  test('an in-flight change matching the position is one hop, in flight', async () => {
    const { reader } = divergentToken();
    const view = await new WalletSession(reader).registration(TOKEN);

    assert.equal(view.state, 'registering');
    assert.equal(view.furtherHopsBehind, false);
    assert.match(view.meaning, /bringing the register level/);
  });

  test('never frames it as a failure, and always says the token is not blocked', async () => {
    // A bare search for "error" would flag the copy that says "not an error",
    // which is the wording we want. Ban the affirmative framings instead.
    const affirmativeFailure =
      /\b(an error occurred|transaction failed|failed to|could not complete|is stuck|blocked until)\b/i;

    for (const scenario of [divergentToken(), cancelledGapToken(), projectionOnlyToken()]) {
      const view = await new WalletSession(scenario.reader).registration(TOKEN);
      const text = `${view.headline} ${view.meaning} ${view.action}`;

      assert.doesNotMatch(text, affirmativeFailure, `"${view.state}" framed it as a failure`);
      assert.match(view.meaning, /not blocked/);
    }
  });

  test('says outright that a pending registration is not a failure', async () => {
    for (const scenario of [divergentToken(), cancelledGapToken()]) {
      const { contract, reader } = scenario;
      contract.transfer(TOKEN, STRANGER);
      const view = await new WalletSession(reader).registration(TOKEN);
      assert.match(view.meaning, /not a failure/);
    }
  });

  test('the action is to wait, and nothing needs fixing', async () => {
    const view = await new WalletSession(divergentToken().reader).registration(TOKEN);
    assert.match(view.action, /^Wait\./);
    assert.match(view.action, /nothing to fix/);
  });

  test('a register with nothing in flight is distinguished from one catching up', async () => {
    const { contract, reader } = cancelledGapToken();
    contract.transfer(TOKEN, STRANGER);

    const view = await new WalletSession(reader).registration(TOKEN);
    assert.equal(view.state, 'behind-with-nothing-in-flight');
    assert.match(view.meaning, /no change is currently in flight/);
    assert.equal(view.commitmentWindow, undefined);
  });

  test('a passed window points at the trade terms, and advises nothing', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 3_600n);

    const view = await new WalletSession(reader).registration(TOKEN);
    assert.equal(view.commitmentWindow?.passed, true);
    assert.match(view.commitmentWindow?.note ?? '', /terms you agreed with your counterparty/);
    assert.match(view.commitmentWindow?.note ?? '', /not by this wallet/);
  });

  test('says who to ask, and that it cannot resolve them', async () => {
    const view = await new WalletSession(divergentToken().reader).registration(TOKEN);
    assert.match(view.whoToAsk, /cannot look it up for you/);
    assert.ok(view.whoToAsk.includes(view.registerId));
  });

  test('renders without claiming a hop count it cannot know', async () => {
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, STRANGER);
    const rendered = renderRegistration(await new WalletSession(reader).registration(TOKEN));

    assert.match(rendered, /at least one further transfer/);
    assert.doesNotMatch(rendered, /\b[0-9]+ (hops|transfers) behind\b/);
  });
});

describe('agreement is not verified identity', () => {
  test('both the aligned and diverged notes say the protocol cannot verify it', async () => {
    const { contract, reader } = divergentToken();
    const diverged = await new WalletSession(reader).assetView(TOKEN);
    assert.equal(diverged.alignment.aligned, false);
    assert.match(diverged.alignment.note, /does not, and cannot, check/);

    contract.transfer(TOKEN, ALICE);
    const aligned = await new WalletSession(reader).assetView(TOKEN);
    assert.equal(aligned.alignment.aligned, true);
    assert.match(aligned.alignment.note, /not verified identity/);
    assert.match(aligned.alignment.note, /does not, and cannot, check/);
  });
});

describe('before acquiring', () => {
  test('states that the instant of purchase is never final', async () => {
    const view = await new WalletSession(divergentToken().reader).acquisitionDisclosure(TOKEN);
    assert.ok(view.points.some((point) => /will not be final at the moment it happens/.test(point)));
  });

  test('says when the acquirer is joining a queue', async () => {
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, STRANGER);

    const view = await new WalletSession(reader).acquisitionDisclosure(TOKEN);
    assert.ok(view.points.some((point) => /joining a queue, not the front of one/.test(point)));
  });

  test('gives no verdict and gates nothing', async () => {
    const view = await new WalletSession(divergentToken().reader).acquisitionDisclosure(TOKEN);
    const text = renderAcquisitionDisclosure(view).toLowerCase();

    assert.match(view.boundary, /does not score the token/);
    assert.match(view.boundary, /does not prevent you/);
    for (const word of ['recommend', 'you should', 'safe to', 'unsafe', 'avoid this']) {
      assert.ok(!text.includes(word), `acquisition disclosure gave a verdict: ${word}`);
    }
  });

  test('a contract with no settlement interface is not read as "register is current"', async () => {
    const view = await new WalletSession(projectionOnlyToken().reader).acquisitionDisclosure(TOKEN);
    assert.ok(
      view.points.some((point) => /not evidence that the register is\s+current/.test(point)),
    );
  });
});

describe('stale is not pending', () => {
  const ASSET = `0x${'a5'.repeat(32)}`;

  function tower(options: { stale: boolean }) {
    const contract = new MemoryWatchtowerContract({ blockNumber: 1_000n });
    contract.registerAsset(ASSET, {
      steward: REGISTRAR,
      finalityDepth: 0n,
      maxFreshnessThreshold: 1_000n,
    });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: options.stale ? 5n : 500n,
      key: REGISTRAR,
    });
    if (options.stale) contract.advanceBlocks(100n);
    return new MemoryWatchtowerReader(contract);
  }

  test('a stale feed is its own case, even when the instant is final', async () => {
    const { reader } = divergentToken();
    const session = new WalletSession(reader, {
      watchtower: { reader: tower({ stale: true }), assetId: ASSET, provenance: 'configured' },
    });

    // T.finalInstant IS final on this token.
    const posture = await session.posture(TOKEN, T.finalInstant);
    assert.equal(posture.case, 'feed-not-current');
    assert.notEqual(posture.case, 'expected-change-feed-current');
    assert.match(posture.explanation, /may have stopped speaking/);
    assert.match(posture.explanation, /says nothing about whether the instant is final/);
  });

  test('a provisional instant on a live feed is ordinary catching up', async () => {
    const { reader } = divergentToken();
    const session = new WalletSession(reader, {
      watchtower: { reader: tower({ stale: false }), assetId: ASSET, provenance: 'configured' },
    });

    const posture = await session.posture(TOKEN, T.asOf);
    assert.equal(posture.case, 'expected-change-feed-current');
    assert.match(posture.explanation, /ordinary catching up/);
  });

  test('no feed configured is unknown, not current', async () => {
    const posture = await new WalletSession(divergentToken().reader).posture(TOKEN, T.finalInstant);
    assert.equal(posture.case, 'no-feed-configured');
    assert.match(posture.explanation, /Unknown is not the same as current/);
  });

  test('reports the pair and recommends neither', async () => {
    const rendered = renderPosture(
      describePosture(
        describeFinality({
          tokenId: TOKEN,
          instant: T.asOf,
          reported: false,
          firstEffectiveAt: T.v1,
          latestEffectiveAt: T.v3,
        }),
        noWatchtower(),
      ),
    );
    assert.match(rendered, /Projection/);
    assert.match(rendered, /Attestation feed/);
    assert.match(rendered, /not advice/);
    assert.match(rendered, /holds no consideration/);
  });

  test('freshness still carries its own binding honesty', async () => {
    const view = await buildFreshnessView({
      reader: tower({ stale: false }),
      assetId: ASSET,
      provenance: 'configured',
    });
    assert.match(view.bindingNote ?? '', /No on-chain link exists/);
  });
});

describe('collisions the protocol does not prevent', () => {
  test('finds one register entry backing two tokens', async () => {
    const contract = new MemoryRegisterContract({ now: T.beforeFirstEntry });
    contract.mint(1n, ALICE);
    contract.mint(2n, CAROL);
    // Every single-token invariant holds on both; only a comparison sees it.
    contract.seedEntries(1n, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);
    contract.seedEntries(2n, [{ holder: CAROL, effectiveAt: T.v1, seed: 'a' }]);

    const report = await detectCollisions(new MemoryErc8415Reader(contract), [1n, 2n]);
    const collision = report.collisions.find((item) => item.kind === 'recordCommitment');

    assert.notEqual(collision, undefined);
    assert.equal(collision?.crossToken, true);
    assert.deepEqual(
      collision?.occurrences.map((occurrence) => occurrence.tokenId),
      [1n, 2n],
    );
    assert.match(collision?.note ?? '', /individually well formed/);
  });

  test('a single-token view cannot see it', async () => {
    const contract = new MemoryRegisterContract({ now: T.beforeFirstEntry });
    contract.mint(1n, ALICE);
    contract.mint(2n, CAROL);
    contract.seedEntries(1n, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);
    contract.seedEntries(2n, [{ holder: CAROL, effectiveAt: T.v1, seed: 'a' }]);
    const reader = new MemoryErc8415Reader(contract);

    // The history walk on either token reports an intact chain.
    assert.equal((await new WalletSession(reader).history(1n)).chainIntact, true);
    assert.equal((await new WalletSession(reader).history(2n)).chainIntact, true);
    // Only the comparison finds it.
    assert.equal((await detectCollisions(reader, [1n, 2n])).collisions.length > 0, true);
  });

  test('finding none is never reported as proof none exists', async () => {
    const report = await detectCollisions(divergentToken().reader, [TOKEN]);
    assert.deepEqual(report.collisions, []);
    assert.match(report.scopeNote, /not evidence that none exists/);
    assert.match(renderCollisions(report), /not evidence that none exists/);
  });

  test('a repeat within one token is flagged as non-conformance, not a collision', async () => {
    const { reader } = divergentToken();
    const report = await detectCollisions(reader, [TOKEN]);
    assert.equal(report.entriesExamined, 3);
    assert.deepEqual(report.collisions, []);
  });
});

describe('reads are snapshots', () => {
  test('a request carries the intent it was built from', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.cancelSettlement({
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });
    assert.equal(request.intent.kind, 'cancelSettlement');
  });

  test('re-deriving an untouched request reports no change', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.cancelSettlement({
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });
    const again = await session.revalidate(request);

    assert.equal(again.unchanged, true);
    assert.equal(again.refusedBy, undefined);
    assert.deepEqual(again.changed, []);
  });

  test('re-deriving after the state moved reports the refusal rather than throwing', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.cancelSettlement({
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });

    // A proof lands underneath the built request.
    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.openGapDeadline + 2n,
      proofData: '0x',
    });

    const again = await session.revalidate(request);
    assert.equal(again.unchanged, false);
    assert.equal(again.current, undefined);
    assert.ok(again.refusedBy?.some((check) => check.name === 'settlement is open'));
  });

  test('names the on-chain atomic read as the recommended shape', async () => {
    const { contract, reader } = divergentToken();
    contract.advanceTo(T.openGapDeadline + 1n);
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.cancelSettlement({
      settlementId: OPEN_GAP_ID,
      reasonHash: commitment('9'),
    });
    const note = request.preflight.consequences.join(' ');

    assert.match(note, /recommended shape is to call holderAsOf/);
    assert.match(note, /same transaction as the action/);
    assert.match(note, /not an equal alternative/);
  });
});
