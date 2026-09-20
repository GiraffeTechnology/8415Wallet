import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import { AsynchronousRegistrar } from '../src/adapters/memory/registrar.ts';
import { ALICE, CAROL, DAVE, ERIN, REGISTRAR, TOKEN } from '../src/adapters/memory/scenarios.ts';
import { WalletSession } from '../src/wallet/session.ts';

/**
 * A register that takes three minutes while the token changes hands in thirty
 * seconds.
 *
 * Every other fixture here admits entries at the convenience of the test. This
 * one has a register with its own clock and its own queue, which is the
 * situation the standard exists for and the one nothing had exercised: the
 * Sepolia run's registrar was the two counterparties, admitting a minute after
 * they traded because someone ran the next command.
 *
 * The numbers are the ones a dealer would recognise. Transfers every 30s,
 * registration 180s per hop, serial.
 */

const SECOND = 1n;
const TRANSFER_INTERVAL = 30n * SECOND;
const REGISTRATION_LATENCY = 180n * SECOND;
const START = 1_800_000_000n;

function register() {
  const contract = new MemoryRegisterContract({ now: START, settlementPeriod: 30n * 24n * 60n * 60n });
  contract.mint(TOKEN, ALICE);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);
  const registrar = new AsynchronousRegistrar(contract, {
    registrationLatency: REGISTRATION_LATENCY,
    registrar: REGISTRAR,
  });
  // The opening record: Alice is the confirmed holder from the start.
  registrar.observeTransfer(TOKEN, ALICE);
  registrar.advanceTo(START + REGISTRATION_LATENCY);
  return { contract, registrar, reader: new MemoryErc8415Reader(contract) };
}

describe('a register three minutes behind a chain that moves in thirty seconds', () => {
  test('the position moves and the confirmed holder does not', async () => {
    const { contract, registrar, reader } = register();
    const tradedAt = contract.now;
    registrar.observeTransfer(TOKEN, CAROL);

    // Thirty seconds later the token has moved and the register has not.
    registrar.advanceTo(tradedAt + TRANSFER_INTERVAL);
    assert.equal(await reader.ownerOf(TOKEN), CAROL);
    assert.equal((await reader.currentEntry(TOKEN)).holder, ALICE);
    assert.equal(await reader.holderAsOf(TOKEN, contract.now), ALICE);

    // This is the normal state of a trade in flight, and the wallet says so
    // rather than calling it a failure.
    // It says so by denying it outright, not by avoiding the word: banning
    // "failure" would flag the sentence that exists to rule one out.
    const view = await new WalletSession(reader).registration(TOKEN);
    assert.match(view.meaning, /not a failure/i);
    assert.match(view.meaning, /not blocked/i);
    assert.match(view.meaning, /one at a time|sequential/i);
    assert.doesNotMatch(view.headline + view.meaning + view.action, /rejected|refused|invalid/i);
  });

  test('the record lands backdated to when the transfer happened', async () => {
    const { contract, registrar, reader } = register();
    const tradedAt = contract.now;
    registrar.observeTransfer(TOKEN, CAROL);
    registrar.advanceTo(tradedAt + REGISTRATION_LATENCY);

    const entry = await reader.currentEntry(TOKEN);
    assert.equal(entry.holder, CAROL);
    // Recorded three minutes late, effective at the moment of the transfer.
    assert.equal(entry.effectiveAt, tradedAt);
    assert.equal(contract.now - entry.effectiveAt, REGISTRATION_LATENCY);

    // And so the instant of the trade now resolves to Carol, in arrears.
    assert.equal(await reader.holderAsOf(TOKEN, tradedAt), CAROL);
  });

  test('falling behind compounds: a→b→c→d at 30s against 180s a hop', async () => {
    const { contract, registrar } = register();
    const t0 = contract.now;

    // Three hops, thirty seconds apart.
    const toCarol = registrar.observeTransfer(TOKEN, CAROL);
    contract.advanceTo(t0 + TRANSFER_INTERVAL);
    const toDave = registrar.observeTransfer(TOKEN, DAVE);
    contract.advanceTo(t0 + 2n * TRANSFER_INTERVAL);
    const toErin = registrar.observeTransfer(TOKEN, ERIN);

    // Serial, so each hop starts when the one before it finishes. The lag is
    // not a constant three minutes — it grows with every trade.
    assert.equal(toCarol.recordableAt, t0 + 180n);
    assert.equal(toDave.recordableAt, t0 + 360n);
    assert.equal(toErin.recordableAt, t0 + 540n);

    // Sixty seconds in, the token is three owners ahead of its own record.
    assert.equal(registrar.pending.length, 3);
    assert.equal(registrar.backlogAt(contract.now), 60n);
  });

  test('the hops are recorded in order, and each settles the one before it', async () => {
    const { contract, registrar, reader } = register();
    const t0 = contract.now;
    registrar.observeTransfer(TOKEN, CAROL);
    contract.advanceTo(t0 + TRANSFER_INTERVAL);
    registrar.observeTransfer(TOKEN, DAVE);

    // After the first record: Carol is confirmed, and the instant of her
    // trade is still provisional because nothing later exists yet.
    registrar.advanceTo(t0 + 180n);
    assert.equal((await reader.currentEntry(TOKEN)).holder, CAROL);
    assert.equal(await reader.isFinalAsOf(TOKEN, t0), false);

    // After the second: Dave is confirmed, and Carol's instant is now final,
    // because a later entry closed the interval it sat in.
    registrar.advanceTo(t0 + 360n);
    assert.equal((await reader.currentEntry(TOKEN)).holder, DAVE);
    assert.equal(await reader.isFinalAsOf(TOKEN, t0), true);
    assert.equal(await reader.holderAsOf(TOKEN, t0), CAROL);

    // Finality arrives in arrears. The newest instant is never final.
    assert.equal(await reader.isFinalAsOf(TOKEN, contract.now), false);
  });

  test('entries stay append-only and strictly increasing through the backlog', async () => {
    const { contract, registrar, reader } = register();
    const t0 = contract.now;
    for (const holder of [CAROL, DAVE, ERIN]) {
      registrar.observeTransfer(TOKEN, holder);
      contract.advanceTo(contract.now + TRANSFER_INTERVAL);
    }
    registrar.advanceTo(t0 + 1000n);

    const count = await reader.entryCount(TOKEN);
    assert.equal(count, 4n); // the opening record plus three hops
    let previous = 0n;
    const seen = new Set<string>();
    for (let version = 1n; version <= count; version += 1n) {
      const entry = await reader.entryAt(TOKEN, version);
      assert.equal(entry.version, version);
      assert.ok(entry.effectiveAt > previous, `v${version} must exceed its predecessor`);
      assert.ok(!seen.has(entry.recordCommitment), 'commitments are unique within a token');
      seen.add(entry.recordCommitment);
      previous = entry.effectiveAt;
    }
    assert.equal((await reader.currentEntry(TOKEN)).holder, ERIN);
  });

  test('while the register is mid-hop the instant is contested, and settles nothing', async () => {
    const { contract, registrar, reader } = register();
    const t0 = contract.now;
    registrar.observeTransfer(TOKEN, CAROL);
    const inFlight = registrar.beginRecordingNext();
    assert.notEqual(inFlight, undefined);

    // A gap is open: the register is working. That is a separate signal from
    // finality, and it decides nothing about it.
    const gap = await reader.openGapOf!(TOKEN);
    assert.notEqual(gap, `0x${'00'.repeat(32)}`);
    assert.equal((await reader.currentEntry(TOKEN)).holder, ALICE);
    assert.equal(await reader.isFinalAsOf(TOKEN, t0), false);

    registrar.finishRecording();
    assert.equal((await reader.currentEntry(TOKEN)).holder, CAROL);
    assert.equal(await reader.openGapOf!(TOKEN), `0x${'00'.repeat(32)}`);
  });

  test('the two sequences are reported side by side, never merged', async () => {
    const { contract, registrar, reader } = register();
    registrar.observeTransfer(TOKEN, CAROL);
    registrar.advanceTo(contract.now + TRANSFER_INTERVAL);

    const view = await new WalletSession(reader).assetView(TOKEN);
    assert.equal(view.tradeablePosition.owner, CAROL);
    assert.equal(view.confirmedHolder.holder, ALICE);
    assert.notEqual(view.tradeablePosition.owner, view.confirmedHolder.holder);
    assert.equal(view.alignment.aligned, false);
  });
});
