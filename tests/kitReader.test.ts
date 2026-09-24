import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KitProjectionApi, KitTransportError } from '../src/adapters/kit/kitApi.ts';
import { KitErc8415Reader } from '../src/adapters/kit/kitReader.ts';
import { divergentToken, OPEN_GAP_ID, T, TOKEN } from '../src/adapters/memory/scenarios.ts';
import {
  BackendDisagreementError,
  ContractRevertError,
  InvariantViolationError,
} from '../src/sdk/errors.ts';
import type { Erc8415Reader } from '../src/sdk/port.ts';
import { checkReaderConformance, type ConformanceProbe } from '../src/sdk/readerConformance.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';
import { delegateReader } from './support/delegateReader.ts';
import { fakeKitFetch, type FakeKitOptions } from './support/fakeKit.ts';

const PROBE: ConformanceProbe = {
  tokenId: TOKEN,
  coveredInstant: T.finalInstant,
  instantBeforeFirstEntry: T.beforeFirstEntry,
};

const BASE_URL = 'http://localhost:8415';

/**
 * A Kit-backed reader over the same contract the rest of the suite reads, with
 * that contract's own reader standing in for the chain half.
 *
 * This is the shape a deployment actually takes: the projection reads come
 * from the indexer, the position, the clock and conformance stay on chain.
 */
function kitReader(
  chain: Erc8415Reader,
  options: FakeKitOptions = {},
): KitErc8415Reader {
  const api = new KitProjectionApi({ baseUrl: BASE_URL, fetch: fakeKitFetch(chain, options) });
  return new KitErc8415Reader(api, chain, chain.source, { chainIdentity: chain });
}

describe('the Kit adapter is held to the same port as the chain adapter', () => {
  test('it conforms, over the Kit wire format', async () => {
    const { reader } = divergentToken();
    const report = await checkReaderConformance(kitReader(reader), PROBE);
    assert.deepEqual(report.findings, []);
    assert.equal(report.conforms, true);
  });

  test('it answers the projection identically to the chain', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader);

    assert.deepEqual(await kit.currentEntry(TOKEN), await reader.currentEntry(TOKEN));
    assert.deepEqual(await kit.entryAt(TOKEN, 2n), await reader.entryAt(TOKEN, 2n));
    assert.deepEqual(await kit.entryAsOf(TOKEN, T.asOf), await reader.entryAsOf(TOKEN, T.asOf));
    assert.equal(await kit.holderAsOf(TOKEN, T.asOf), await reader.holderAsOf(TOKEN, T.asOf));
    assert.equal(await kit.isFinalAsOf(TOKEN, T.asOf), await reader.isFinalAsOf(TOKEN, T.asOf));
    assert.equal(await kit.entryCount(TOKEN), await reader.entryCount(TOKEN));
    assert.equal(await kit.registerId(), await reader.registerId());
    assert.equal(await kit.openGapOf(TOKEN), OPEN_GAP_ID);
  });

  test('the position still comes from the chain, never from the index', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader);

    // The scenario's whole point: these two disagree, and must keep
    // disagreeing. An indexer that served both would be asserting the
    // identity ERC-8415 exists to deny.
    const position = await kit.ownerOf(TOKEN);
    const confirmed = (await kit.currentEntry(TOKEN)).holder;
    assert.notEqual(position, confirmed);
    assert.equal(position, await reader.ownerOf(TOKEN));
  });
});

describe('a backend that cannot answer is never read as an answer', () => {
  test('an unreachable Kit is a transport failure, not a claim about the register', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader, { failWith: { status: 503, error: 'UNAVAILABLE' } });

    await assert.rejects(() => kit.holderAsOf(TOKEN, T.asOf), (error: unknown) => {
      assert.ok(error instanceof KitTransportError);
      assert.equal(error.status, 503);
      // Emphatically not a revert: a revert would be reported as the
      // projection declining to answer, which it did not do.
      assert.ok(!(error instanceof ContractRevertError));
      return true;
    });
  });

  test('an unauthenticated Kit is a transport failure too', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader, { failWith: { status: 401, error: 'UNAUTHENTICATED' } });
    await assert.rejects(() => kit.entryCount(TOKEN), KitTransportError);
  });

  test('an instant the projection does not cover is a revert, as on chain', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader);
    await assert.rejects(() => kit.entryAsOf(TOKEN, T.beforeFirstEntry), ContractRevertError);
    await assert.rejects(() => kit.holderAsOf(TOKEN, T.beforeFirstEntry), ContractRevertError);
    // And the one call that must not revert for it, does not.
    assert.equal(await kit.isFinalAsOf(TOKEN, T.beforeFirstEntry), false);
  });
});

describe('the two backends are checked against each other', () => {
  test('an index pointed at another register is refused, not preferred', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader, { registerId: `0x${'9'.repeat(64)}` });
    await assert.rejects(() => kit.entryCount(TOKEN), BackendDisagreementError);
  });

  test('a mismatched verification profile is refused as well', async () => {
    const { reader } = divergentToken();
    const kit = kitReader(reader, { verificationProfile: `0x${'7'.repeat(64)}` });
    await assert.rejects(() => kit.registerId(), BackendDisagreementError);
  });

  test('the check can be declined, and then nothing cross-checks it', async () => {
    const { reader } = divergentToken();
    const api = new KitProjectionApi({
      baseUrl: BASE_URL,
      fetch: fakeKitFetch(reader, { registerId: `0x${'9'.repeat(64)}` }),
    });
    const kit = new KitErc8415Reader(api, reader, reader.source, { crossCheckIdentity: false });
    assert.equal(await kit.registerId(), `0x${'9'.repeat(64)}`);
  });
});

describe('the derived reads are checked rather than assumed', () => {
  test('currentEntry refuses an entry whose interval is already closed', async () => {
    const { reader } = divergentToken();
    // An index one entry behind the register: `entryAt(2)` answers, and the
    // answer is a superseded entry. Labelling it "current" would report a
    // holder the register has already moved past.
    const lagging = delegateReader(reader, { entryCount: async () => 2n });
    const kit = new KitErc8415Reader(
      new KitProjectionApi({ baseUrl: BASE_URL, fetch: fakeKitFetch(lagging) }),
      reader,
      reader.source,
      { crossCheckIdentity: false },
    );
    await assert.rejects(() => kit.currentEntry(TOKEN), InvariantViolationError);
  });

  test('currentEntry refuses a version that does not match the count', async () => {
    const { reader } = divergentToken();
    const honest = fakeKitFetch(reader);
    // The count says three entries; the version route serves the second. The
    // two reads disagree, so neither can be trusted to be the latest.
    const inconsistent: typeof honest = async (url, init) =>
      url.endsWith('/entry/version/3') ? honest(`${BASE_URL}/projection/${TOKEN}/entry/version/2`, init) : honest(url, init);
    const kit = new KitErc8415Reader(
      new KitProjectionApi({ baseUrl: BASE_URL, fetch: inconsistent }),
      reader,
      reader.source,
      { crossCheckIdentity: false },
    );
    await assert.rejects(() => kit.currentEntry(TOKEN), InvariantViolationError);
  });
});

describe('integers survive the wire', () => {
  test('an instant beyond a double is carried exactly', async () => {
    // 2^53 + 1 is the first instant a JSON number cannot hold. An entry that
    // takes effect far enough in the future ends a projection permanently,
    // which is exactly the value worth reporting accurately.
    const beyondDouble = (1n << 53n) + 1n;
    const fetchOne = async () => ({
      status: 200,
      json: async () => ({
        entry: {
          version: '1',
          holder: `0x${'a'.repeat(40)}`,
          effectiveAt: beyondDouble.toString(),
          supersededAt: '0',
          recordCommitment: `0x${'1'.repeat(64)}`,
          previousCommitment: ZERO_BYTES32,
          registryReference: `0x${'2'.repeat(64)}`,
        },
      }),
    });
    const api = new KitProjectionApi({ baseUrl: BASE_URL, fetch: fetchOne });
    const entry = await api.entryAt(TOKEN, 1n);
    assert.equal(entry.effectiveAt, beyondDouble);
    assert.notEqual(entry.effectiveAt, BigInt(Number(beyondDouble)));
  });

  test('an integer that is not a decimal string is refused', async () => {
    const fetchOne = async () => ({
      status: 200,
      json: async () => ({ entry: { version: 1, holder: `0x${'a'.repeat(40)}` } }),
    });
    const api = new KitProjectionApi({ baseUrl: BASE_URL, fetch: fetchOne });
    await assert.rejects(() => api.entryAt(TOKEN, 1n), KitTransportError);
  });
});

describe('the base URL is refused before a key can leak', () => {
  test('plain http to a remote host is refused', () => {
    assert.throws(
      () => new KitProjectionApi({ baseUrl: 'http://kit.example.com', apiKey: 'secret' }),
      KitTransportError,
    );
  });

  test('embedded credentials are refused', () => {
    assert.throws(
      () => new KitProjectionApi({ baseUrl: 'https://user:pass@kit.example.com' }),
      KitTransportError,
    );
  });
});
