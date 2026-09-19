import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { RpcErc8415Reader } from '../src/adapters/rpc/rpcReader.ts';
import { HttpCallTransport } from '../src/adapters/rpc/transport.ts';
import { ContractRevertError, TransportError } from '../src/sdk/errors.ts';

/**
 * A revert is something a contract does. Everything else is the node.
 *
 * This distinction has failed here twice. An unreachable endpoint was once
 * reported as "the contract does not advertise `0x6309e170`", and a public
 * Sepolia provider refusing an over-wide log range was reported as
 * `call reverted: exceed maximum block range: 50000`. Both were the transport
 * wearing the contract's clothes, and both were found by running the wallet
 * against a real node rather than by a suite.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the global fetch with a single JSON-RPC reply, recording the calls. */
function replyWith(body: unknown, ok = true, status = 200) {
  const calls: { method: string; params: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const sent = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] };
    calls.push({ method: sent.method, params: sent.params });
    return { ok, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

const REVERT = { error: { code: 3, message: 'execution reverted', data: '0x1d1b039c' } };
const RANGE_REFUSED = { error: { code: -32000, message: 'exceed maximum block range: 50000' } };

describe('what the transport calls a revert', () => {
  test('an eth_call revert carrying error data is a revert', async () => {
    replyWith(REVERT);
    const transport = new HttpCallTransport('https://node.example');
    await assert.rejects(() => transport.call(`0x${'ab'.repeat(20)}`, '0x12345678'), ContractRevertError);
  });

  test('an eth_call the node refused for its own reasons is not a revert', async () => {
    // Rate limiting is not the contract declining to answer. Reporting it as a
    // revert lets every caller that treats a revert as an answer absorb it.
    replyWith({ error: { code: -32005, message: 'rate limit exceeded' } });
    const transport = new HttpCallTransport('https://node.example');
    await assert.rejects(
      () => transport.call(`0x${'ab'.repeat(20)}`, '0x12345678'),
      (error: unknown) => {
        assert.ok(error instanceof TransportError);
        assert.ok(!(error instanceof ContractRevertError));
        assert.equal(error.code, -32005);
        return true;
      },
    );
  });

  test('a refused log range is a transport failure, not a revert', async () => {
    // The exact reply a public Sepolia endpoint gave the shipped wallet.
    replyWith(RANGE_REFUSED);
    const transport = new HttpCallTransport('https://node.example');
    await assert.rejects(
      () => transport.getLogs({ address: `0x${'ab'.repeat(20)}` }),
      (error: unknown) => {
        assert.ok(error instanceof TransportError, 'must not be a revert');
        assert.ok(!(error instanceof ContractRevertError));
        assert.match(error.message, /eth_getLogs/);
        return true;
      },
    );
  });

  test('no method other than eth_call can produce a revert', async () => {
    replyWith(REVERT);
    const transport = new HttpCallTransport('https://node.example');
    for (const read of [
      () => transport.getLogs({}),
      () => transport.blockTimestamp(),
      () => transport.blockNumber(),
      () => transport.codeAt(`0x${'ab'.repeat(20)}`, 1n),
    ]) {
      await assert.rejects(read, (error: unknown) => {
        assert.ok(!(error instanceof ContractRevertError), 'a non-call method reported a revert');
        assert.ok(error instanceof TransportError);
        return true;
      });
    }
  });

  test('an unreachable endpoint and a non-JSON reply are transport failures', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await assert.rejects(() => new HttpCallTransport('https://node.example').blockTimestamp(), TransportError);

    replyWith({}, false, 503);
    await assert.rejects(() => new HttpCallTransport('https://node.example').blockTimestamp(), TransportError);
  });
});

describe('reading a whole history without asking for it all at once', () => {
  const ADDRESS = `0x${'cd'.repeat(20)}`;

  /** A node that refuses any span wider than its cap, as real ones do. */
  function windowedNode(deploymentBlock: bigint, head: bigint, cap: bigint) {
    const spans: { from: bigint; to: bigint }[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const sent = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] };
      const reply = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ result }) });

      if (sent.method === 'eth_blockNumber') return reply(`0x${head.toString(16)}`) as unknown as Response;
      if (sent.method === 'eth_getCode') {
        const at = BigInt(sent.params[1] as string);
        return reply(at >= deploymentBlock ? '0x6001' : '0x') as unknown as Response;
      }
      if (sent.method === 'eth_getLogs') {
        const filter = sent.params[0] as { fromBlock?: string; toBlock?: string };
        if (filter.fromBlock === 'earliest' || filter.toBlock === 'latest') {
          return { ok: true, status: 200, json: async () => RANGE_REFUSED } as unknown as Response;
        }
        const from = BigInt(filter.fromBlock!);
        const to = BigInt(filter.toBlock!);
        if (to - from + 1n > cap) {
          return { ok: true, status: 200, json: async () => RANGE_REFUSED } as unknown as Response;
        }
        spans.push({ from, to });
        return reply([
          { address: ADDRESS, topics: [`0x${'11'.repeat(32)}`], data: '0x', blockNumber: `0x${from.toString(16)}`, logIndex: '0x0' },
        ]) as unknown as Response;
      }
      return reply(null) as unknown as Response;
    }) as typeof fetch;
    return spans;
  }

  test('finds the deployment block by bisection and starts there', async () => {
    const spans = windowedNode(90_000n, 100_000n, 50_000n);
    const reader = new RpcErc8415Reader(new HttpCallTransport('https://node.example'), 1n, ADDRESS, {
      logWindow: 5_000n,
    });
    await reader.getLogs({ address: ADDRESS, topics: [] });

    assert.equal(spans[0]?.from, 90_000n, 'the scan did not start at the deployment block');
    // Nothing before the deployment is asked for. Blocks 90,000-100,000
    // inclusive in 5,000-block windows is three requests, not twenty.
    assert.equal(spans.length, 3);
    assert.equal(spans.at(-1)?.to, 100_000n);
  });

  test('covers the range contiguously, with no gap and no overlap', async () => {
    const spans = windowedNode(0n, 25_000n, 50_000n);
    const reader = new RpcErc8415Reader(new HttpCallTransport('https://node.example'), 1n, ADDRESS, {
      logWindow: 10_000n,
    });
    await reader.getLogs({ address: ADDRESS, topics: [] });

    assert.deepEqual(spans, [
      { from: 0n, to: 9_999n },
      { from: 10_000n, to: 19_999n },
      { from: 20_000n, to: 25_000n },
    ]);
  });

  test('returns every window s logs, not just the last', async () => {
    windowedNode(0n, 25_000n, 50_000n);
    const reader = new RpcErc8415Reader(new HttpCallTransport('https://node.example'), 1n, ADDRESS, {
      logWindow: 10_000n,
    });
    const logs = await reader.getLogs({ address: ADDRESS, topics: [] });
    assert.equal(logs.length, 3);
    assert.deepEqual(logs.map((log) => log.blockNumber), [0n, 10_000n, 20_000n]);
  });

  test('a refused window raises rather than returning a short history', async () => {
    // The whole point. A partial answer here is indistinguishable from a
    // projection that never moved, and the wallet must not hand one over.
    windowedNode(0n, 25_000n, 5_000n);
    const reader = new RpcErc8415Reader(new HttpCallTransport('https://node.example'), 1n, ADDRESS, {
      logWindow: 10_000n,
    });
    await assert.rejects(() => reader.getLogs({ address: ADDRESS, topics: [] }), TransportError);
  });

  test('a supplied start block skips the bisection entirely', async () => {
    const spans = windowedNode(90_000n, 100_000n, 50_000n);
    const reader = new RpcErc8415Reader(new HttpCallTransport('https://node.example'), 1n, ADDRESS, {
      logWindow: 50_000n,
      fromBlock: 95_000n,
    });
    await reader.getLogs({ address: ADDRESS, topics: [] });
    assert.deepEqual(spans, [{ from: 95_000n, to: 100_000n }]);
  });
});
