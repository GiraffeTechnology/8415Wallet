import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import {
  MemoryWatchtowerContract,
  MemoryWatchtowerReader,
} from '../src/adapters/memory/watchtower.ts';
import {
  ALICE,
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  STRANGER,
  T,
  TOKEN,
  cancelledGapToken,
  commitment,
  divergentToken,
  settlementId,
} from '../src/adapters/memory/scenarios.ts';
import { IdentityChangedError } from '../src/sdk/errors.ts';
import { AUDIT_SCHEMA, serialiseAuditTrail } from '../src/wallet/auditTrail.ts';
import { WalletSession } from '../src/wallet/session.ts';
import { bindByRegistrar } from '../src/sdk/watchtower.ts';
import type { TransactionRequest, TransactionSigner } from '../src/sdk/transactions.ts';
import { delegateReader } from './support/delegateReader.ts';
import { executeTransaction } from './support/executeTransaction.ts';

describe('one session, one identity pin', () => {
  test('a register that changes between two views is caught', async () => {
    const { reader } = divergentToken();

    // The pin is only meaningful if the reads share it. Views constructing
    // their own would each compare a value against itself.
    let reads = 0;
    const drifting = delegateReader(reader, {
      registerId: async () => {
        reads += 1;
        return reads === 1 ? await reader.registerId() : `0x${'ab'.repeat(32)}`;
      },
    });

    const session = new WalletSession(drifting);
    await session.assetView(TOKEN);
    await assert.rejects(() => session.history(TOKEN), IdentityChangedError);
  });

  test('a stable contract passes every view', async () => {
    const session = new WalletSession(divergentToken().reader, { account: REGISTRAR });
    await session.assetView(TOKEN);
    await session.temporalQuery(TOKEN, T.asOf);
    await session.history(TOKEN);
    await session.settlementLog(TOKEN);
    await session.riskSurfaces(TOKEN);
    assert.equal(session.identity.pinned?.address, session.reader.source.address);
  });
});

describe('the session is the application seam', () => {
  test('every view is reachable, and the account reaches authority', async () => {
    const session = new WalletSession(divergentToken().reader, { account: REGISTRAR });

    assert.equal((await session.assetView(TOKEN)).authority.authorized, true);
    assert.equal((await session.temporalQuery(TOKEN, T.asOf)).finality.display, 'provisional');
    assert.equal((await session.history(TOKEN)).entries.length, 3);
    assert.equal((await session.settlementLog(TOKEN)).available, true);
    assert.equal((await session.riskSurfaces(TOKEN)).surfaces.length, 5);
  });

  test('a watch-only session reads everything and builds nothing', async () => {
    const session = new WalletSession(divergentToken().reader);

    assert.equal(session.account, undefined);
    assert.equal((await session.assetView(TOKEN)).authority.authorized, undefined);
    assert.throws(() => session.transactions, /watch-only/);
  });

  test('freshness is not configured unless a feed is bound', async () => {
    const session = new WalletSession(divergentToken().reader);
    assert.equal((await session.freshness()).display, 'not-configured');
  });
});

describe('sending', () => {
  test('hands the built request to a signer and never signs itself', async () => {
    const { contract, reader } = cancelledGapToken();
    const session = new WalletSession(reader, { account: REGISTRAR });

    let handed: TransactionRequest | undefined;
    const signer: TransactionSigner = {
      account: REGISTRAR,
      sendTransaction: async (request) => {
        handed = request;
        executeTransaction(contract, request);
        return '0xhash';
      },
    };

    const request = await session.transactions.beginSettlement({
      tokenId: TOKEN,
      settlementId: settlementId('4'),
      expectedHolder: DAVE,
      snapshotHash: commitment('5'),
      deadline: contract.now + 600n,
    });
    assert.equal(await session.send(request, signer), '0xhash');

    assert.equal(handed?.from, REGISTRAR);
    assert.equal(await reader.openGapOf(TOKEN), settlementId('4'));
  });

  test('refuses a signer holding a different account', async () => {
    const { contract, reader } = cancelledGapToken();
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.beginSettlement({
      tokenId: TOKEN,
      settlementId: settlementId('4'),
      expectedHolder: DAVE,
      snapshotHash: commitment('5'),
      deadline: contract.now + 600n,
    });

    await assert.rejects(
      () =>
        session.send(request, {
          account: STRANGER,
          sendTransaction: async () => assert.fail('the signer must not be reached'),
        }),
      /built for .*the signer holds/,
    );
  });
});

describe('the audit trail', () => {
  test('carries every entry with integers as strings', async () => {
    const session = new WalletSession(divergentToken().reader);
    const trail = await session.auditTrail(TOKEN);

    assert.equal(trail.schema, AUDIT_SCHEMA);
    assert.equal(trail.entries.length, 3);
    assert.equal(trail.tokenId, TOKEN.toString());
    assert.equal(trail.entries[2]?.effectiveAt, T.v3.toString());
    assert.equal(trail.entries[2]?.supersededAt, '0');
    for (const entry of trail.entries) {
      assert.equal(typeof entry.version, 'string');
      assert.equal(typeof entry.effectiveAt, 'string');
    }
  });

  test('records both ownership notions, and the instant the reads were taken', async () => {
    const session = new WalletSession(divergentToken().reader);
    const trail = await session.auditTrail(TOKEN);

    assert.equal(trail.tradeablePosition.owner, DAVE);
    assert.equal(trail.entries[2]?.holder, ALICE);
    assert.equal(trail.observedAt, T.asOf.toString());
  });

  test('carries gap transitions with the block and log index each was emitted at', async () => {
    const session = new WalletSession(cancelledGapToken().reader);
    const trail = await session.auditTrail(TOKEN);

    assert.equal(trail.settlementLog.available, true);
    const cancelled = trail.settlementLog.episodes.find((item) => item.closure === 'cancelled');
    assert.notEqual(cancelled, undefined);
    assert.ok(trail.settlementLog.events.length > 0);
    for (const event of trail.settlementLog.events) {
      assert.match(event.blockNumber, /^\d+$/);
      assert.match(event.logIndex, /^\d+$/);
    }
  });

  test('says when the gap log could not be read, rather than exporting an empty one', async () => {
    const { reader } = cancelledGapToken();
    const { getLogs: _omitted, ...withoutLogs } = delegateReader(reader, {});
    const trail = await new WalletSession(withoutLogs).auditTrail(TOKEN);

    assert.equal(trail.settlementLog.available, false);
    assert.ok(trail.notes.some((note) => /not a record that none occurred/.test(note)));
  });

  test('survives a round trip through JSON without losing a value', async () => {
    const session = new WalletSession(divergentToken().reader);
    const trail = await session.auditTrail(TOKEN);
    const parsed = JSON.parse(serialiseAuditTrail(trail)) as typeof trail;

    assert.deepEqual(parsed, trail);
    // A uint64 that a JSON number would round is preserved exactly.
    assert.equal(parsed.entries[2]?.effectiveAt, '1764839520');
  });

  test('reports a broken commitment chain rather than omitting it', async () => {
    const { reader } = divergentToken();
    const tampered = delegateReader(reader, {
      entryAt: async (tokenId, version) => {
        const entry = await reader.entryAt(tokenId, version);
        return version === 2n ? { ...entry, previousCommitment: commitment('9') } : entry;
      },
    });

    const trail = await new WalletSession(tampered).auditTrail(TOKEN);
    assert.equal(trail.chainIntact, false);
    assert.ok(trail.entries[1]?.linkFaults.includes('previous-commitment-mismatch'));
  });
});

describe('the watchtower binding is asserted, never verified', () => {
  test('a derived assetId is marked computed and says what it claims to track', async () => {
    const tower = new MemoryWatchtowerContract({ blockNumber: 1_000n });
    const towerReader = new MemoryWatchtowerReader(tower);
    const salt = `0x${'5a'.repeat(32)}`;
    const assetId = await towerReader.computeAssetId(REGISTRAR, salt);

    tower.registerAsset(assetId, {
      steward: REGISTRAR,
      finalityDepth: 0n,
      maxFreshnessThreshold: 1_000n,
    });
    tower.submit(assetId, {
      signedAtBlock: 1_000n,
      sequenceNumber: 1n,
      freshnessThreshold: 500n,
      key: REGISTRAR,
    });

    const { reader } = divergentToken();
    const registerId = await reader.registerId();
    const binding = await bindByRegistrar(towerReader, REGISTRAR, salt, registerId);
    assert.equal(binding.provenance, 'computed');
    assert.equal(binding.assetId, assetId);

    const view = await new WalletSession(reader, { watchtower: binding }).freshness();
    assert.equal(view.display, 'reorg-safe');
    assert.equal(view.source?.address, tower.address);
    assert.match(view.bindingNote ?? '', /computeAssetId/);
    assert.match(view.bindingNote ?? '', /No on-chain link exists/);
    assert.match(view.bindingNote ?? '', new RegExp(registerId));
  });

  test('computeAssetId is deterministic and separates registrars', async () => {
    const tower = new MemoryWatchtowerReader(new MemoryWatchtowerContract());
    const salt = `0x${'5a'.repeat(32)}`;

    assert.equal(
      await tower.computeAssetId(REGISTRAR, salt),
      await tower.computeAssetId(REGISTRAR, salt),
    );
    assert.notEqual(
      await tower.computeAssetId(REGISTRAR, salt),
      await tower.computeAssetId(STRANGER, salt),
    );
  });
});

describe('contract identity in the asset view', () => {
  test('carries the settlement period even while no gap is open', async () => {
    const session = new WalletSession(cancelledGapToken().reader);
    const view = await session.assetView(TOKEN);

    assert.equal(view.gap.kind, 'none');
    assert.equal(view.settlementPeriod, 30n * 24n * 60n * 60n);
  });

  test('reports no settlement period when there is no interface', async () => {
    const contract = new (await import('../src/adapters/memory/register.ts')).MemoryRegisterContract(
      { now: T.beforeFirstEntry, conformance: { settlement: false } },
    );
    contract.mint(TOKEN, ALICE);
    contract.seedEntries(TOKEN, [
      { holder: ALICE, effectiveAt: T.v1, seed: 'a' },
      { holder: DAVE, effectiveAt: T.v3, seed: 'c' },
    ]);
    contract.advanceTo(T.asOf);

    const view = await new WalletSession(new MemoryErc8415Reader(contract)).assetView(TOKEN);
    assert.equal(view.settlementPeriod, undefined);
  });
});

describe('there is no fourth write operation', () => {
  test('the transaction surface is exactly the ERC’s three', async () => {
    const session = new WalletSession(divergentToken().reader, { account: REGISTRAR });
    assert.deepEqual(Object.keys(session.transactions).sort(), [
      'beginSettlement',
      'cancelSettlement',
      'finalizeSettlement',
    ]);
  });

  test('admitting an entry still requires an open gap and a proof', async () => {
    const { contract, reader } = divergentToken();
    const session = new WalletSession(reader, { account: REGISTRAR });

    const request = await session.transactions.finalizeSettlement({
      settlementId: OPEN_GAP_ID,
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });
    // The wallet cannot make this succeed; the contract's verifier decides.
    assert.ok(request.preflight.unverifiable.some((check) => check.name === 'proof validity'));
    executeTransaction(contract, request);
    assert.equal(await reader.entryCount(TOKEN), 4n);
  });
});
