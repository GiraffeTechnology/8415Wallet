import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatAddress, formatDuration, formatInstant, shortHex } from '../src/wallet/format.ts';
import { ALICE, T } from '../src/adapters/memory/scenarios.ts';

describe('formatInstant', () => {
  test('carries the queried integer alongside the calendar time', () => {
    assert.equal(formatInstant(T.asOf), '2026-01-01 00:00:00 UTC (1767225600)');
    assert.equal(formatInstant(T.v3), '2025-12-04 09:12:00 UTC (1764839520)');
  });

  test('the integer is always recoverable from the rendered string', () => {
    for (const instant of [0n, T.v1, T.v3, T.asOf, T.later]) {
      const rendered = formatInstant(instant);
      const recovered = rendered.match(/\((\d+)\)$/)?.[1];
      assert.equal(recovered, instant.toString());
    }
  });

  test('reports a far-future instant instead of rendering an invalid date', () => {
    // A uint64 effectiveAt this far out permanently ends the projection for
    // that token, so it has to survive being displayed.
    const farFuture = (1n << 63n) + 7n;
    const rendered = formatInstant(farFuture);
    assert.ok(rendered.startsWith(farFuture.toString()));
    assert.ok(!rendered.includes('Invalid'));
    assert.ok(rendered.includes('beyond representable calendar time'));
  });

  test('handles the epoch itself', () => {
    assert.equal(formatInstant(0n), '1970-01-01 00:00:00 UTC (0)');
  });
});

describe('formatDuration', () => {
  test('renders days, hours and minutes', () => {
    assert.equal(formatDuration(0n), '0m');
    assert.equal(formatDuration(90n), '1m');
    assert.equal(formatDuration(3_600n), '1h');
    assert.equal(formatDuration(86_400n + 3_600n + 120n), '1d 1h 2m');
  });

  test('shows a passed deadline as negative rather than clamping it', () => {
    assert.equal(formatDuration(-7_200n), '-2h');
  });
});

describe('hex rendering', () => {
  test('never truncates an address', () => {
    assert.equal(formatAddress(ALICE), ALICE);
    assert.equal(formatAddress(ALICE).length, 42);
  });

  test('abbreviates opaque 32-byte values', () => {
    const value = `0x${'ab'.repeat(32)}`;
    const short = shortHex(value);
    assert.ok(short.startsWith('0xabababab'));
    assert.ok(short.endsWith('ababab'));
    assert.ok(short.length < value.length);
  });
});
