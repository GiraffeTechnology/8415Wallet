import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AccountMismatchError,
  ChainMismatchError,
  Eip1193Signer,
  RefusedFailingPreflightError,
  type Eip1193Provider,
} from '../src/adapters/signing/eip1193Signer.ts';
import { commitment, divergentToken, REGISTRAR, settlementId, T, TOKEN, DAVE } from '../src/adapters/memory/scenarios.ts';
import { buildBeginSettlement } from '../src/sdk/transactions.ts';
import type { TransactionRequest } from '../src/sdk/transactions.ts';

const HASH = `0x${'7a'.repeat(32)}`;

type Call = { method: string; params?: readonly unknown[] };

/** A provider that records what it was asked, and answers what it was told to. */
function fakeProvider(over: { chainId?: string; accounts?: string[]; hash?: unknown } = {}) {
  const calls: Call[] = [];
  const provider: Eip1193Provider = {
    async request(args) {
      calls.push(args);
      switch (args.method) {
        case 'eth_chainId':
          return over.chainId ?? '0x1';
        case 'eth_accounts':
          return over.accounts ?? [REGISTRAR];
        case 'eth_sendTransaction':
          // `in` rather than `??`, so a provider that answers null is modelled
          // as answering null rather than silently becoming a good hash.
          return 'hash' in over ? over.hash : HASH;
        default:
          throw new Error(`unexpected method ${args.method}`);
      }
    },
  };
  return { provider, calls };
}

async function aRequest(): Promise<TransactionRequest> {
  const { reader } = divergentToken();
  return buildBeginSettlement(reader, REGISTRAR, {
    tokenId: TOKEN,
    settlementId: settlementId('4'),
    expectedHolder: DAVE,
    snapshotHash: commitment('5'),
    deadline: T.asOf + 7n * 24n * 60n * 60n,
  });
}

describe('sending a transaction the wallet built', () => {
  test('passes it through exactly as built', async () => {
    const request = await aRequest();
    const { provider, calls } = fakeProvider();
    const signer = new Eip1193Signer(provider, REGISTRAR);

    assert.equal(await signer.sendTransaction(request), HASH);

    const sent = calls.find((call) => call.method === 'eth_sendTransaction');
    assert.deepEqual(sent?.params, [
      { from: request.from, to: request.to, data: request.data, value: '0x0' },
    ]);
  });

  test('holds no key material and asks the provider for none', async () => {
    const request = await aRequest();
    const { provider, calls } = fakeProvider();
    await new Eip1193Signer(provider, REGISTRAR).sendTransaction(request);

    for (const call of calls) {
      assert.ok(
        !/privateKey|eth_sign|personal_sign|eth_signTransaction/i.test(call.method),
        `the signer asked for ${call.method}`,
      );
    }
    assert.deepEqual(
      calls.map((call) => call.method),
      ['eth_chainId', 'eth_sendTransaction'],
    );
  });
});

describe('the three refusals', () => {
  test('a provider on another chain is refused before anything is sent', async () => {
    // The same address is a different contract on a different chain, so this
    // is not a failed transaction — it is a successful one against something
    // else. The user can switch networks between building and sending.
    const request = await aRequest();
    const { provider, calls } = fakeProvider({ chainId: '0xaa36a7' });
    await assert.rejects(
      () => new Eip1193Signer(provider, REGISTRAR).sendTransaction(request),
      ChainMismatchError,
    );
    assert.ok(!calls.some((call) => call.method === 'eth_sendTransaction'));
  });

  test('a sender this signer does not hold is refused', async () => {
    const request = await aRequest();
    const { provider, calls } = fakeProvider();
    await assert.rejects(
      () => new Eip1193Signer(provider, DAVE).sendTransaction(request),
      AccountMismatchError,
    );
    assert.ok(!calls.some((call) => call.method === 'eth_sendTransaction'));
  });

  test('a hand-assembled request with a failing preflight is refused', async () => {
    const request = await aRequest();
    const tampered: TransactionRequest = {
      ...request,
      preflight: {
        ...request.preflight,
        blocking: [{ name: 'authority', outcome: 'failed', detail: 'not a settlement authority' }],
      },
    };
    const { provider, calls } = fakeProvider();
    await assert.rejects(
      () => new Eip1193Signer(provider, REGISTRAR).sendTransaction(tampered),
      RefusedFailingPreflightError,
    );
    assert.ok(!calls.some((call) => call.method === 'eth_sendTransaction'));
  });

  test('what the wallet could not check is not a refusal', async () => {
    // Treating "could not establish" as "would fail" would make every contract
    // without a settlement interface unusable. The caller is told and decides.
    const request = await aRequest();
    const unverifiable: TransactionRequest = {
      ...request,
      preflight: {
        ...request.preflight,
        unverifiable: [{ name: 'proof', outcome: 'unverifiable', detail: 'profile is opaque here' }],
      },
    };
    const { provider } = fakeProvider();
    assert.equal(
      await new Eip1193Signer(provider, REGISTRAR).sendTransaction(unverifiable),
      HASH,
    );
  });
});

describe('connecting', () => {
  test('takes the account the provider already offers, and prompts for none', async () => {
    const { provider, calls } = fakeProvider({ accounts: [REGISTRAR.toUpperCase().replace('0X', '0x')] });
    const signer = await Eip1193Signer.connect(provider);
    assert.equal(signer.account, REGISTRAR.toLowerCase());
    // Connecting is the application's decision and its prompt, not this
    // library's to trigger.
    assert.ok(!calls.some((call) => call.method === 'eth_requestAccounts'));
  });

  test('says so when there is no account rather than inventing one', async () => {
    const { provider } = fakeProvider({ accounts: [] });
    await assert.rejects(() => Eip1193Signer.connect(provider), /connect it first/);
  });
});

describe('what comes back', () => {
  test('a reply that is not a transaction hash is refused', async () => {
    const request = await aRequest();
    for (const hash of [null, '0x', 42, `0x${'7a'.repeat(31)}`]) {
      const { provider } = fakeProvider({ hash });
      await assert.rejects(
        () => new Eip1193Signer(provider, REGISTRAR).sendTransaction(request),
        /no transaction hash/,
      );
    }
  });
});
