import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  CAROL,
  T,
  TOKEN,
  commitment,
  divergentToken,
  projectionOnlyToken,
} from '../src/adapters/memory/scenarios.ts';
import { ProjectionNotInitialized } from '../src/sdk/errors.ts';
import { ZERO_BYTES32, type RegisterEntry } from '../src/sdk/types.ts';
import { buildHistoryView } from '../src/wallet/history.ts';
import { renderHistory } from '../src/wallet/renderTemporalQuery.ts';
import { delegateReader } from './support/delegateReader.ts';

describe('the entry walk', () => {
  test('returns every entry, in admission order, unfiltered', async () => {
    const { reader } = divergentToken();
    const view = await buildHistoryView(reader, TOKEN);

    assert.equal(view.entries.length, 3);
    assert.deepEqual(
      view.entries.map((item) => item.entry.version),
      [1n, 2n, 3n],
    );
    assert.equal(BigInt(view.entries.length), await reader.entryCount(TOKEN));
  });

  test('shows each interval closed at its successor, and the latest left open', async () => {
    const { reader } = divergentToken();
    const view = await buildHistoryView(reader, TOKEN);

    assert.equal(view.entries[0]!.entry.effectiveAt, T.v1);
    assert.equal(view.entries[0]!.intervalEnd, T.v2);
    assert.equal(view.entries[1]!.intervalEnd, T.v3);
    assert.equal(view.entries[2]!.intervalEnd, undefined);
  });

  test('carries commitments and an opaque reference per entry', async () => {
    const { reader } = divergentToken();
    const view = await buildHistoryView(reader, TOKEN);

    assert.equal(view.entries[0]!.entry.previousCommitment, ZERO_BYTES32);
    assert.equal(view.entries[1]!.entry.previousCommitment, commitment('a'));
    assert.equal(view.entries[2]!.entry.previousCommitment, commitment('b'));
    for (const item of view.entries) {
      assert.notEqual(item.entry.registryReference, item.entry.recordCommitment);
    }
  });

  test('a holder appearing twice is two entries, never merged', async () => {
    // Alice holds at v1 and again at v3. The register recorded two separate
    // facts, and collapsing them would erase the interval Carol held.
    const { reader } = divergentToken();
    const view = await buildHistoryView(reader, TOKEN);

    assert.equal(view.entries[0]!.entry.holder, ALICE);
    assert.equal(view.entries[1]!.entry.holder, CAROL);
    assert.equal(view.entries[2]!.entry.holder, ALICE);
  });
});

describe('the commitment chain', () => {
  test('reads as intact for a conforming projection', async () => {
    const { reader } = divergentToken();
    const view = await buildHistoryView(reader, TOKEN);

    assert.equal(view.chainIntact, true);
    assert.deepEqual(
      view.entries.flatMap((item) => item.linkFaults),
      [],
    );
    assert.match(view.note, /Commitments are compared, never recomputed/);
  });

  test('detects a broken previous-commitment link', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 2n
          ? ({ ...entry, previousCommitment: commitment('9') } satisfies RegisterEntry)
          : entry;
      },
    });

    const view = await buildHistoryView(tampered, TOKEN);
    assert.equal(view.chainIntact, false);
    assert.ok(view.entries[1]!.linkFaults.includes('previous-commitment-mismatch'));
    assert.match(view.note, /cannot be relied on/);
  });

  test('detects a non-zero previous commitment on the first entry', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 1n
          ? ({ ...entry, previousCommitment: commitment('9') } satisfies RegisterEntry)
          : entry;
      },
    });

    const view = await buildHistoryView(tampered, TOKEN);
    assert.ok(view.entries[0]!.linkFaults.includes('first-entry-has-nonzero-previous'));
  });

  test('detects an interval not closed at its successor', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 1n
          ? ({ ...entry, supersededAt: entry.supersededAt + 1n } satisfies RegisterEntry)
          : entry;
      },
    });

    const view = await buildHistoryView(tampered, TOKEN);
    assert.ok(view.entries[0]!.linkFaults.includes('interval-not-closed-at-successor'));
  });

  test('detects a non-increasing effective time and a version gap together', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 2n
          ? ({ ...entry, version: 7n, effectiveAt: T.v1 } satisfies RegisterEntry)
          : entry;
      },
    });

    const view = await buildHistoryView(tampered, TOKEN);
    const faults = view.entries[1]!.linkFaults;
    assert.ok(faults.includes('version-not-consecutive'));
    assert.ok(faults.includes('effective-time-not-increasing'));
  });

  test('shows faults rather than correcting them', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 2n
          ? ({ ...entry, previousCommitment: commitment('9') } satisfies RegisterEntry)
          : entry;
      },
    });

    const view = await buildHistoryView(tampered, TOKEN);
    // The entry is still reported exactly as read.
    assert.equal(view.entries[1]!.entry.previousCommitment, commitment('9'));
    assert.match(renderHistory(view), /FAULTS\s+previous-commitment-mismatch/);
  });
});

describe('rendering', () => {
  test('lists newest first while keeping versions readable', async () => {
    const { reader } = divergentToken();
    const rendered = renderHistory(await buildHistoryView(reader, TOKEN));

    assert.ok(rendered.indexOf('v3') < rendered.indexOf('v2'));
    assert.ok(rendered.indexOf('v2') < rendered.indexOf('v1'));
    assert.match(rendered, /Chain of commitments: intact/);
  });

  test('marks the first entry’s zero previous commitment', async () => {
    const { reader } = divergentToken();
    assert.match(renderHistory(await buildHistoryView(reader, TOKEN)), /zero — first entry/);
  });

  test('every rendered instant carries its integer', async () => {
    const { reader } = divergentToken();
    const rendered = renderHistory(await buildHistoryView(reader, TOKEN));
    const bare = rendered.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC(?! \(\d+\))/g) ?? [];
    assert.deepEqual(bare, []);
  });

  test('walks a projection with no settlement interface', async () => {
    const view = await buildHistoryView(projectionOnlyToken().reader, TOKEN);
    assert.equal(view.entries.length, 2);
    assert.equal(view.chainIntact, true);
  });
});

describe('gating', () => {
  test('an uninitialized projection is reported', async () => {
    const contract = new MemoryRegisterContract({ now: T.v1 });
    contract.mint(TOKEN, ALICE);

    await assert.rejects(
      () => buildHistoryView(new MemoryErc8415Reader(contract), TOKEN),
      ProjectionNotInitialized,
    );
  });
});
