import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const { waitForReceipt } = require_('../scripts/controls/scenario-kit.cjs');
// The package's export map hides its internals, so this reaches the installed
// file directly: the point is to test the library that actually runs.
const { PollingTransactionSubscriber } = require_(join(
  dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ethers',
  'lib.commonjs', 'providers', 'subscriber-polling.js'));

const HASH = `0x${'ab'.repeat(32)}`;
const unknownError = () => Object.assign(new Error('could not coalesce error'), { code: 'UNKNOWN_ERROR' });

/** Records every rejection that escapes the awaited path while `body` runs. */
async function escapedRejections(body: () => Promise<unknown>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const listeners = process.listeners('unhandledRejection');
  for (const listener of listeners) process.off('unhandledRejection', listener);
  const capture = (reason: unknown) => { escaped.push(reason); };
  process.on('unhandledRejection', capture);
  try {
    await body();
    // Rejections are reported on a later turn of the loop than the throw.
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    process.off('unhandledRejection', capture);
    for (const listener of listeners) process.on('unhandledRejection', listener as never);
  }
  return escaped;
}

test('the polling subscriber leaks a failed receipt read as an unhandled rejection', async () => {
  // The failure a funded public run actually died of, reproduced against the
  // installed library. It is recorded here so the reason the wait below exists
  // cannot quietly stop being true.
  const provider = {
    getTransactionReceipt: async () => { throw unknownError(); },
    on() {}, off() {}, emit() {},
  };
  const escaped = await escapedRejections(async () => {
    new PollingTransactionSubscriber(provider, HASH).start();
  });
  assert.equal(escaped.length, 1, 'expected exactly one escaped rejection from one read');
  assert.equal((escaped[0] as { code?: string }).code, 'UNKNOWN_ERROR');
});

test('waiting for a receipt survives a transient read failure without escaping', async () => {
  const receipt = { blockNumber: 100, status: 1 };
  let reads = 0;
  const provider = {
    getTransactionReceipt: async () => {
      reads += 1;
      if (reads <= 3) throw unknownError();
      return receipt;
    },
    getBlockNumber: async () => 100,
  };
  const escaped = await escapedRejections(async () => {
    assert.equal(await waitForReceipt(provider, HASH, { confirmations: 1, timeout: 20000, pollMs: 1 }), receipt);
  });
  assert.deepEqual(escaped, [], 'a retried read must not escape the awaited path');
  assert.equal(reads, 4);
});

test('a provider that never answers fails closed rather than waiting forever', async () => {
  let reads = 0;
  const provider = {
    getTransactionReceipt: async () => { reads += 1; throw unknownError(); },
    getBlockNumber: async () => 100,
  };
  await assert.rejects(
    waitForReceipt(provider, HASH, { confirmations: 1, timeout: 20000, pollMs: 1, readFailureLimit: 4 }),
    (error: { code?: string }) => error.code === 'UNKNOWN_ERROR');
  assert.equal(reads, 5, 'the read is bounded: the limit, then one more that reports it');
});

test('the wait expires instead of hanging when no receipt ever appears', async () => {
  const provider = { getTransactionReceipt: async () => null, getBlockNumber: async () => 100 };
  await assert.rejects(waitForReceipt(provider, HASH, { confirmations: 1, timeout: 30, pollMs: 1 }),
    /SCENARIO_RECEIPT_WAIT_EXPIRED/);
});

test('a receipt is not accepted before the requested confirmation depth', async () => {
  const receipt = { blockNumber: 100, status: 1 };
  let head = 100;
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => { head += 1; return head; },
  };
  // Depth 3 needs head 102; the head advances one block per poll.
  assert.equal(await waitForReceipt(provider, HASH, { confirmations: 3, timeout: 20000, pollMs: 1 }), receipt);
  assert.ok(head >= 102, `expected to wait for depth, stopped at head ${head}`);
});

test('a head that cannot be read defers the answer rather than inventing depth', async () => {
  const receipt = { blockNumber: 100, status: 1 };
  let heads = 0;
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => {
      heads += 1;
      if (heads <= 2) throw unknownError();
      return 100;
    },
  };
  const escaped = await escapedRejections(async () => {
    assert.equal(await waitForReceipt(provider, HASH, { confirmations: 1, timeout: 20000, pollMs: 1 }), receipt);
  });
  assert.deepEqual(escaped, []);
  assert.equal(heads, 3);
});
