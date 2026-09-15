import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { encodeLog } from '../src/adapters/memory/encodeEvents.ts';
import {
  DAVE,
  OPEN_GAP_ID,
  REGISTRAR,
  T,
  TOKEN,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import {
  EVENT_DEFINITIONS,
  decodeLog,
  encodeTopic,
  tokenFilter,
  topicOf,
  type EventName,
} from '../src/sdk/events.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';

describe('event topics', () => {
  test('topic0 is the keccak of the canonical signature', () => {
    for (const name of Object.keys(EVENT_DEFINITIONS) as EventName[]) {
      assert.equal(topicOf(name), keccak256Utf8(EVENT_DEFINITIONS[name].signature));
      assert.equal(topicOf(name).length, 66);
    }
  });

  test('every event has a distinct topic0', () => {
    const names = Object.keys(EVENT_DEFINITIONS) as EventName[];
    assert.equal(new Set(names.map(topicOf)).size, names.length);
  });

  test('the token filter puts tokenId in the right slot per event', () => {
    const address = '0x4f2a000000000000000000000000000000000001';
    const token = encodeTopic('uint256', TOKEN);

    // The settlement events lead with identifiers, so the slot differs.
    assert.equal(tokenFilter(address, 'RegisterInitialized', TOKEN).topics[1], token);
    assert.equal(tokenFilter(address, 'SettlementStarted', TOKEN).topics[2], token);
    assert.equal(tokenFilter(address, 'SettlementSuperseded', TOKEN).topics[3], token);
  });

  test('a filter is no longer than the event has topics', () => {
    const address = '0x4f2a000000000000000000000000000000000001';
    for (const name of Object.keys(EVENT_DEFINITIONS) as EventName[]) {
      assert.equal(
        tokenFilter(address, name, TOKEN).topics.length,
        EVENT_DEFINITIONS[name].indexed.length + 1,
      );
    }
  });
});

describe('log decoding', () => {
  test('round-trips every emitted event through the wire encoding', () => {
    const { contract } = divergentToken();
    const logs = encodeLog(contract.log, contract.address);
    assert.ok(logs.length > 0);

    for (const log of logs) {
      const decoded = decodeLog(log);
      assert.notEqual(decoded, undefined, `undecodable log with topic0 ${log.topics[0]}`);
    }
  });

  test('recovers indexed and non-indexed fields correctly', () => {
    const { contract } = divergentToken();
    const decoded = encodeLog(contract.log, contract.address)
      .map(decodeLog)
      .filter((event) => event?.kind === 'SettlementStarted');

    const openGap = decoded.find((event) => event?.settlementId === OPEN_GAP_ID);
    assert.notEqual(openGap, undefined);
    if (openGap?.kind !== 'SettlementStarted') return;

    assert.equal(openGap.tokenId, TOKEN); // indexed
    assert.equal(openGap.initiator, REGISTRAR); // indexed
    assert.equal(openGap.expectedHolder, DAVE); // data
    assert.equal(openGap.deadline, T.openGapDeadline); // data
  });

  test('recovers a uint64 indexed parameter from its topic', () => {
    const { contract } = divergentToken();
    const superseded = encodeLog(contract.log, contract.address)
      .map(decodeLog)
      .filter((event) => event?.kind === 'RegisterSuperseded');

    assert.equal(superseded.length, 2);
    assert.deepEqual(
      superseded.map((event) => (event?.kind === 'RegisterSuperseded' ? event.version : undefined)),
      [2n, 3n],
    );
  });

  test('returns undefined for a log it cannot name, rather than guessing', () => {
    const decoded = decodeLog({
      address: '0x4f2a000000000000000000000000000000000001',
      topics: [`0x${'ff'.repeat(32)}`],
      data: '0x',
      blockNumber: 1n,
      logIndex: 0n,
    });
    assert.equal(decoded, undefined);
  });

  test('rejects a log whose topic count does not match the event', () => {
    const decoded = decodeLog({
      address: '0x4f2a000000000000000000000000000000000001',
      topics: [topicOf('SettlementCancelled'), encodeTopic('uint256', TOKEN)],
      data: '0x',
      blockNumber: 1n,
      logIndex: 0n,
    });
    assert.equal(decoded, undefined);
  });

  test('does not name the ERC-721 transfer sequence as an ERC-8415 event', () => {
    const { contract } = divergentToken();
    const transfers = contract.log.filter((item) => item.event.kind === 'Transfer');
    assert.ok(transfers.length > 0, 'the scenario does transfer the position');
    // Recorded on the contract, and deliberately not encoded as one of these.
    assert.equal(
      encodeLog(contract.log, contract.address).length,
      contract.log.length - transfers.length,
    );
  });
});
