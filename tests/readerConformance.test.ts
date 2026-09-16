import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeLog, matchesFilter } from '../src/adapters/memory/encodeEvents.ts';
import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import { ALICE, T, TOKEN, divergentToken, projectionOnlyToken } from '../src/adapters/memory/scenarios.ts';
import { RpcErc8415Reader } from '../src/adapters/rpc/rpcReader.ts';
import { checkReaderConformance, type ConformanceProbe } from '../src/sdk/readerConformance.ts';
import { delegateReader } from './support/delegateReader.ts';

const PROBE: ConformanceProbe = {
  tokenId: TOKEN,
  coveredInstant: T.finalInstant,
  instantBeforeFirstEntry: T.beforeFirstEntry,
};

describe('every adapter must behave the same way', () => {
  test('the in-memory adapter conforms', async () => {
    const report = await checkReaderConformance(divergentToken().reader, PROBE);
    assert.deepEqual(report.findings, []);
    assert.equal(report.conforms, true);
  });

  test('the projection-only adapter conforms', async () => {
    const report = await checkReaderConformance(projectionOnlyToken().reader, {
      ...PROBE,
      coveredInstant: T.finalInstant,
    });
    assert.deepEqual(report.findings, []);
  });

  test('the rpc adapter conforms, over the real calldata encoding', async () => {
    // The same checks through selector encoding, word packing and decoding.
    const { contract } = divergentToken();
    const { FakeEvmNode } = await import('./support/fakeNode.ts');
    const rpc = new RpcErc8415Reader(new FakeEvmNode(contract), contract.chainId, contract.address);

    const report = await checkReaderConformance(rpc, PROBE);
    assert.deepEqual(report.findings, []);
  });
});

describe('the harness catches an adapter that does not', () => {
  test('one that swallows the before-first-entry revert', async () => {
    const { reader } = divergentToken();
    const lenient = delegateReader(reader, {
      entryAsOf: async (tokenId, instant) =>
        reader.entryAsOf(tokenId, instant < T.v1 ? T.v1 : instant),
    });

    const report = await checkReaderConformance(lenient, PROBE);
    assert.equal(report.conforms, false);
    assert.ok(
      report.findings.some(
        (finding) => finding.check === 'entryAsOf' && /must revert/.test(finding.detail),
      ),
    );
  });

  test('one whose finality answer contradicts the rule', async () => {
    const { reader } = divergentToken();
    const wrong = delegateReader(reader, { isFinalAsOf: async () => false });

    const report = await checkReaderConformance(wrong, PROBE);
    assert.ok(report.findings.some((finding) => finding.check === 'isFinalAsOf'));
  });

  test('one whose holderAsOf disagrees with entryAsOf', async () => {
    const { reader } = divergentToken();
    const wrong = delegateReader(reader, { holderAsOf: async () => ALICE });

    const report = await checkReaderConformance(wrong, {
      ...PROBE,
      coveredInstant: T.finalInstant,
    });
    assert.ok(report.findings.some((finding) => finding.check === 'holderAsOf'));
  });

  test('one that reverts before the first entry on isFinalAsOf', async () => {
    const { reader } = divergentToken();
    const wrong = delegateReader(reader, {
      isFinalAsOf: async (tokenId, instant) => {
        if (instant < T.v1) throw new Error('reverted');
        return reader.isFinalAsOf(tokenId, instant);
      },
    });

    const report = await checkReaderConformance(wrong, PROBE);
    assert.ok(
      report.findings.some((finding) => /must not revert before the first entry/.test(finding.detail)),
    );
  });

  test('a contract advertising no projection stops the check immediately', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      conformance: { projection: false },
    });
    contract.mint(TOKEN, ALICE);

    const report = await checkReaderConformance(new MemoryErc8415Reader(contract), PROBE);
    assert.equal(report.conforms, false);
    assert.deepEqual(
      report.findings.map((finding) => finding.check),
      ['erc165'],
    );
  });
});

describe('the harness checks the adapter, not the deployment', () => {
  test('it reports findings rather than throwing, so a caller sees them all', async () => {
    const { reader } = divergentToken();
    const wrong = delegateReader(reader, {
      isFinalAsOf: async () => false,
      holderAsOf: async () => ALICE,
    });

    const report = await checkReaderConformance(wrong, PROBE);
    assert.ok(report.findings.length >= 2);
    assert.equal(report.address, reader.source.address);
  });

  test('the log encoder and filter round-trip is exercised by both adapters', async () => {
    const { contract } = divergentToken();
    const logs = encodeLog(contract.log, contract.address);
    assert.ok(logs.length > 0);
    assert.ok(
      logs.every((log) => matchesFilter(log, { address: contract.address, topics: [] })),
    );
  });
});
