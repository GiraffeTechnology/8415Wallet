import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import {
  MemoryWatchtowerContract,
  MemoryWatchtowerReader,
} from '../src/adapters/memory/watchtower.ts';
import { REGISTRAR, T, TOKEN, cancelledGapToken, divergentToken } from '../src/adapters/memory/scenarios.ts';
import type { WatchtowerBinding } from '../src/sdk/watchtower.ts';
import { buildFreshnessView, noWatchtower } from '../src/wallet/freshness.ts';
import { buildTemporalView } from '../src/wallet/temporalQuery.ts';

const ASSET = `0x${'a5'.repeat(32)}`;
const KEY = '0x9e900000000000000000000000000000000000aa';

/** The pairing an operator asserts: this feed tracks this projection. */
function binding(reader: MemoryWatchtowerReader): WatchtowerBinding {
  return { reader, assetId: ASSET, provenance: 'configured' };
}

function watchtower(options: { finalityDepth?: bigint } = {}) {
  const contract = new MemoryWatchtowerContract({ blockNumber: 1_000n });
  contract.registerAsset(ASSET, {
    steward: REGISTRAR,
    finalityDepth: options.finalityDepth ?? 32n,
    maxFreshnessThreshold: 1_000n,
  });
  return { contract, reader: new MemoryWatchtowerReader(contract) };
}

describe('the classification rule', () => {
  test('unknown when no head is recorded', async () => {
    const { reader } = watchtower();
    const view = await buildFreshnessView(binding(reader));
    assert.equal(view.reported, 'UNKNOWN');
    assert.equal(view.display, 'unknown');
  });

  test('fresh but reorg-exposed before the head is buried', async () => {
    const { contract, reader } = watchtower({ finalityDepth: 32n });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: KEY,
    });
    contract.advanceBlocks(10n);

    const view = await buildFreshnessView(binding(reader));
    assert.equal(view.reported, 'FRESH_PENDING');
    assert.equal(view.display, 'fresh-reorg-exposed');
    assert.equal(view.age, 10n);
  });

  test('reorg-safe once buried, and labelled as reorg safety', async () => {
    const { contract, reader } = watchtower({ finalityDepth: 32n });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: KEY,
    });
    contract.advanceBlocks(40n);

    const view = await buildFreshnessView(binding(reader));
    // The contract's enum name is preserved on `reported`; the display is not
    // allowed to repeat it.
    assert.equal(view.reported, 'FRESH_FINAL');
    assert.equal(view.display, 'reorg-safe');
    assert.equal(view.label, 'Reorg-safe');
    assert.doesNotMatch(view.label, /final/i);
  });

  test('stale once past the threshold it was signed with', async () => {
    const { contract, reader } = watchtower();
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 50n,
      key: KEY,
    });
    contract.advanceBlocks(51n);

    assert.equal((await buildFreshnessView(binding(reader))).display, 'stale');
  });

  test('a revoked key collapses the head to stale, retroactively', async () => {
    const { contract, reader } = watchtower({ finalityDepth: 0n });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: KEY,
    });
    assert.equal((await buildFreshnessView(binding(reader))).display, 'reorg-safe');

    contract.revokeKey(ASSET, KEY);
    const view = await buildFreshnessView(binding(reader));
    assert.equal(view.display, 'stale');
    assert.match(view.explanation, /revoked key means compromise/);
  });
});

describe('freshness is never finality', () => {
  test('the word "final" appears only where it is denied', async () => {
    const { contract, reader } = watchtower({ finalityDepth: 0n });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: KEY,
    });

    const view = await buildFreshnessView(binding(reader));
    assert.match(view.disclaimer, /Freshness is not finality/);
    assert.match(view.explanation, /not registrar finality and not projection finality/);
    assert.doesNotMatch(view.label, /final/i);
  });

  test('a reorg-safe head does not make a provisional instant final', async () => {
    const { contract, reader } = watchtower({ finalityDepth: 0n });
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: KEY,
    });
    const freshness = await buildFreshnessView(binding(reader));
    assert.equal(freshness.display, 'reorg-safe');

    // Same asset, deepest possible freshness. The projection is unmoved.
    const projection = divergentToken();
    const view = await buildTemporalView(projection.reader, TOKEN, T.asOf);
    assert.equal(view.finality.display, 'provisional');
  });

  test('a stale head does not make a final instant unsettled', async () => {
    const { contract, reader } = watchtower();
    contract.submit(ASSET, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 5n,
      key: KEY,
    });
    contract.advanceBlocks(100n);
    assert.equal((await buildFreshnessView(binding(reader))).display, 'stale');

    const projection = divergentToken();
    const view = await buildTemporalView(projection.reader, TOKEN, T.finalInstant);
    assert.equal(view.finality.display, 'final');
  });

  test('the temporal view carries no freshness field at all', async () => {
    // Structural, not editorial: there is no path for a freshness answer to
    // reach the finality or contest display, because the view has nowhere to
    // put one.
    const { reader } = divergentToken();
    const view = await buildTemporalView(reader, TOKEN, T.asOf);
    assert.ok(!('freshness' in view));
    assert.ok(!('reorgSafe' in view.finality));
  });

  test('no watchtower says nothing about the projection', async () => {
    const view = noWatchtower();
    assert.equal(view.display, 'not-configured');
    assert.match(view.explanation, /says nothing about the projection/);

    const { reader } = cancelledGapToken();
    assert.equal((await buildTemporalView(reader, TOKEN, T.v1)).finality.display, 'final');
  });
});

describe('the watchtower is a separate contract', () => {
  test('it has its own address and is not the projection reader', async () => {
    const { contract } = divergentToken();
    const { contract: tower } = watchtower();
    assert.notEqual(tower.address, contract.address);

    const projectionReader = new MemoryErc8415Reader(contract);
    assert.ok(!('freshnessOf' in projectionReader));
  });
});
