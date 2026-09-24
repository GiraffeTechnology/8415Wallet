import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALICE,
  CAROL,
  DAVE,
  STRANGER,
  T,
  TOKEN,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import { ZERO_ADDRESS } from '../src/sdk/types.ts';
import { buildOwnershipHistory } from '../src/wallet/ownershipHistory.ts';
import { renderOwnershipHistory } from '../src/wallet/renderHolderViews.ts';
import { WalletSession } from '../src/wallet/session.ts';
import { delegateReader } from './support/delegateReader.ts';

describe('both sequences are walked', () => {
  test('the timeline carries position changes and entries', async () => {
    const view = await new WalletSession(divergentToken().reader).ownershipHistory(TOKEN);

    assert.equal(view.available, true);
    assert.equal(view.entries, 3);
    assert.ok(view.positionChanges >= 2, 'the mint and the transfer to Dave');
    assert.ok(view.timeline.some((event) => event.kind === 'position'));
    assert.ok(view.timeline.some((event) => event.kind === 'entry'));
  });

  test('the timeline is ordered by instant', async () => {
    const view = await new WalletSession(divergentToken().reader).ownershipHistory(TOKEN);
    const instants = view.timeline.map((event) => event.at);

    for (let index = 1; index < instants.length; index += 1) {
      assert.ok(instants[index]! >= instants[index - 1]!, 'the timeline went backwards');
    }
  });

  test('a mint is distinguished from a transfer between parties', async () => {
    const view = await new WalletSession(divergentToken().reader).ownershipHistory(TOKEN);
    const minted = view.timeline.filter(
      (event) => event.kind === 'position' && event.minted,
    );

    assert.equal(minted.length, 1);
    assert.equal(minted[0]?.kind === 'position' ? minted[0].from : undefined, ZERO_ADDRESS);
  });

  test('a position change dates from its block, an entry from its effective time', async () => {
    const view = await new WalletSession(divergentToken().reader).ownershipHistory(TOKEN);

    const position = view.timeline.find((event) => event.kind === 'position' && !event.minted);
    assert.equal(position?.kind === 'position' ? position.at : undefined, T.positionTransferred);

    const entry = view.timeline.find((event) => event.kind === 'entry' && event.version === 3n);
    assert.equal(entry?.at, T.v3);
  });
});

describe('the correspondence is inferred, and says so', () => {
  test('an unregistered position change is reported outstanding', async () => {
    const { contract, reader } = divergentToken();
    contract.transfer(TOKEN, STRANGER);

    const view = await buildOwnershipHistory(reader, TOKEN);
    const outstanding = view.outstanding.map((item) => item.to);

    assert.ok(outstanding.includes(STRANGER), 'the newest position is not yet confirmed');
    assert.ok(outstanding.includes(DAVE), 'Dave was never confirmed by an entry either');
  });

  test('a position later confirmed reports the lag between the two facts', async () => {
    // Alice is minted to at v1's block, and entry v1 confirms Alice.
    const view = await buildOwnershipHistory(divergentToken().reader, TOKEN);
    const alice = view.correspondences.find((item) => item.to === ALICE);

    assert.equal(alice?.state, 'apparently-registered');
    assert.notEqual(alice?.apparentEntry, undefined);
    assert.ok((alice?.lag ?? -1n) >= 0n, 'a lag is an interval, not a negative number');
  });

  test('never claims the protocol links the two', async () => {
    const view = await buildOwnershipHistory(divergentToken().reader, TOKEN);

    assert.match(view.caveat, /this wallet’s inference, not the\s+protocol’s/);
    assert.match(view.caveat, /defines no link between a transfer and the entry/);
    assert.match(view.caveat, /may have an entirely\s+different cause/);
    assert.match(renderOwnershipHistory(view), /Apparent correspondence/);
  });

  test('never pairs an entry that precedes the position change', async () => {
    const view = await buildOwnershipHistory(divergentToken().reader, TOKEN);
    for (const item of view.correspondences) {
      if (item.apparentEntry === undefined) continue;
      assert.ok(
        item.apparentEntry.effectiveAt >= item.positionAt,
        'an entry before the move was paired with it',
      );
    }
  });

  test('Carol holds by entry without ever holding the position', async () => {
    // The register can confirm a party the position never belonged to. Nothing
    // in the correspondence should invent a transfer for her.
    const view = await buildOwnershipHistory(divergentToken().reader, TOKEN);

    assert.ok(view.timeline.some((event) => event.kind === 'entry' && event.holder === CAROL));
    assert.ok(!view.correspondences.some((item) => item.to === CAROL));
  });
});

describe('without logs, half the record is missing and it says so', () => {
  test('reports unavailable rather than an empty position history', async () => {
    const { reader } = divergentToken();
    const { getLogs: _omitted, ...withoutLogs } = delegateReader(reader, {});

    const view = await buildOwnershipHistory(withoutLogs, TOKEN);
    assert.equal(view.available, false);
    assert.equal(view.positionChanges, 0);
    assert.match(view.note, /not a statement that the token never moved/);
    assert.match(renderOwnershipHistory(view), /That is half the record/);
    // The projection half is still shown.
    assert.equal(view.timeline.filter((event) => event.kind === 'entry').length, 3);
  });
});
