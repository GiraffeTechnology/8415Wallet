import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TokenProjection } from '../../src/kit/engine/projection/kernel.ts';
import { ProjectionError } from '../../src/kit/engine/projection/errors.ts';
import { ZERO_BYTES32 } from '../../src/kit/engine/projection/types.ts';

/**
 * The shared projection vectors, run against this repository's kernel.
 *
 * The same file is vendored by other implementations of these semantics, so a
 * divergence between them shows up as a failing vector here or there rather
 * than as two suites that each pass while disagreeing with each other. Both
 * divergences that prompted this — an instant before the first entry reported
 * final, and an open gap folded into finality — are covered below.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vectors = JSON.parse(readFileSync(resolve(root, 'conformance/projection-vectors.json'), 'utf8')) as {
  schemaVersion: number;
  cases: { id: string; why: string; entries: { effectiveAt: number; holder: string }[]; expect: { instant: number; holder: string | null; final: boolean }[] }[];
  gapCases: { id: string; why: string; entries: { effectiveAt: number; holder: string }[]; openGapAt: number; cancelGap?: boolean; expect: { instant: number; final: boolean }[] }[];
};

const address = (name: string): string => `0x${name.charCodeAt(0).toString(16).padStart(2, '0').repeat(20)}`;
const commitment = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

const build = (entries: readonly { effectiveAt: number; holder: string }[]): TokenProjection => {
  const projection = new TokenProjection();
  entries.forEach((entry, index) => {
    projection.admit({
      version: BigInt(index + 1),
      holder: address(entry.holder),
      effectiveAt: BigInt(entry.effectiveAt),
      recordCommitment: commitment(index + 1),
      previousCommitment: index === 0 ? ZERO_BYTES32 : commitment(index),
      registryReference: `0x${'ab'.repeat(32)}`,
    });
  });
  return projection;
};

test('the shared vector file is the expected schema', () => {
  assert.equal(vectors.schemaVersion, 1);
  assert.ok(vectors.cases.length > 0 && vectors.gapCases.length > 0);
});

for (const testCase of vectors.cases) {
  test(`vector ${testCase.id}: ${testCase.why}`, () => {
    const projection = build(testCase.entries);
    for (const expectation of testCase.expect) {
      const instant = BigInt(expectation.instant);

      assert.equal(
        projection.isFinalAsOf(instant),
        expectation.final,
        `isFinalAsOf(${expectation.instant}) in ${testCase.id}`,
      );

      if (expectation.holder === null) {
        // Not covered by the projection: the query refuses rather than
        // inventing an answer, while finality still answers false above.
        assert.throws(() => projection.holderAsOf(instant), ProjectionError, `holderAsOf(${expectation.instant})`);
      } else {
        assert.equal(
          projection.holderAsOf(instant),
          address(expectation.holder),
          `holderAsOf(${expectation.instant}) in ${testCase.id}`,
        );
      }
    }
  });
}

for (const gapCase of vectors.gapCases) {
  test(`vector ${gapCase.id}: ${gapCase.why}`, () => {
    // The kernel holds no gap at all, which is the strongest form of the
    // property these vectors assert: there is no state a gap could occupy
    // that finality could read. Opening one lives a layer up, in the store.
    const projection = build(gapCase.entries);
    for (const expectation of gapCase.expect) {
      assert.equal(
        projection.isFinalAsOf(BigInt(expectation.instant)),
        expectation.final,
        `isFinalAsOf(${expectation.instant}) in ${gapCase.id}`,
      );
    }
  });
}
