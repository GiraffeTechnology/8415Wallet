import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPendingNonce, hashControlBytes } from '../src/controls/authorization.ts';
import { ResponsibilityControlClient } from '../src/controls/client.ts';
import { rpcQuantity, submitFixed } from '../src/controls/execution.ts';
import type { Eip1193Provider } from '../src/adapters/signing/eip1193Signer.ts';

const actor = `0x${'2'.repeat(40)}`;
const pin = { chainId: 11155111n, controller: `0x${'1'.repeat(40)}`, runtimeCodeHash: hashControlBytes('0x6000') };
const invalid: unknown[] = [-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
  '0', '0x00', '0x', null, undefined, true, {}, [], 0n];

test('pending nonce accepts only canonical hex or lossless nonnegative wallet numbers', () => {
  for (const n of [0, 1, 127, 256, Number.MAX_SAFE_INTEGER]) assert.equal(controlPendingNonce(n), BigInt(n));
  for (const s of ['0x0', '0x1', '0xff', '0xFFFFFFFF']) assert.equal(controlPendingNonce(s), BigInt(s));
  for (const value of invalid) assert.throws(() => controlPendingNonce(value), /CONTROL_RPC_QUANTITY_REFUSED/);
});

test('receipt and other RPC quantities still refuse numeric values', () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER, ...invalid]) {
    assert.throws(() => rpcQuantity(value), /CONTROL_RPC_QUANTITY_REFUSED/);
  }
  assert.equal(rpcQuantity('0x0'), 0n);
});

function provider(nonce: unknown) {
  const sent: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const p: Eip1193Provider = { async request({ method, params }) {
    requests.push(method);
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_accounts') return [actor];
    if (method === 'eth_call') return '0x';
    if (method === 'eth_getTransactionCount') { assert.deepEqual(params, [actor, 'pending']); return nonce; }
    if (method === 'eth_sendTransaction') { sent.push((params as readonly Record<string, unknown>[])[0]!); return `0x${'3'.repeat(64)}`; }
    throw Error('UNEXPECTED_METHOD');
  } };
  return { p, sent, requests };
}

for (const route of ['control', 'fixed'] as const) {
  const send = async (p: Eip1193Provider, before: () => Promise<void>) => route === 'control'
    ? new ResponsibilityControlClient(p, pin, before).submit({ kind: 'create-account' }, actor)
    : submitFixed(p, { pin, guards: [], actor, data: '0x12345678', value: 0n,
      event: { address: pin.controller, signature: 'Created(address)', indexed: [], dataHash: hashControlBytes('0x') } }, before);
  test(`${route} submission normalizes genuine numeric pending nonce before journaling and sends once`, async () => {
    for (const nonce of [0, 9, '0x0', '0x9']) {
      const { p, sent } = provider(nonce); let journaled = 0;
      const result = await send(p, async () => { journaled++; assert.equal(sent.length, 0); });
      assert.equal(result.nonce, BigInt(nonce)); assert.equal(journaled, 1); assert.equal(sent.length, 1);
      assert.equal(sent[0]!.nonce, `0x${BigInt(nonce).toString(16)}`);
    }
  });
  test(`${route} invalid numeric or malformed nonce never journals or sends`, async () => {
    for (const nonce of invalid) {
      const { p, sent } = provider(nonce); let journaled = false;
      await assert.rejects(send(p, async () => { journaled = true; }), /CONTROL_RPC_QUANTITY_REFUSED/);
      assert.equal(journaled, false); assert.equal(sent.length, 0);
    }
  });
}
