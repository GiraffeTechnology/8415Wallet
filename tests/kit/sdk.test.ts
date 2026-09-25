import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NotCoveredError, ProjectionClient, ProjectionClientError, type HttpLike } from '../../src/kit/sdk/js/index.ts';
import { handle } from '../../src/kit/api/routes.ts';
import { gateway } from './support/gateway.ts';
import { createApi } from '../../src/kit/api/server.ts';
import { SettlementEngine } from '../../src/kit/engine/settlement/engine.ts';
import { AllowListAuthority } from '../../src/kit/engine/settlement/authority.ts';
import { ALICE, BOB, admit, commitment, entry, harness } from './support/fixtures.ts';

const TOKEN = 1n;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'kit');
// Explicit interpreter override for Windows/tool-managed hosts; never skip the
// Python assertions when python3 is absent. No shell evaluation of this value.
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

/** Run the SDK against the real API over a real socket. */
const withServer = async (run: (client: ProjectionClient, h: ReturnType<typeof harness>, connection: { baseUrl: string; apiKey: string }) => Promise<void>) => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  const auth = gateway(h.store);
  const server = createApi(auth.options);
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    await run(new ProjectionClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: auth.issued.secret }), h, { baseUrl: `http://127.0.0.1:${port}`, apiKey: auth.issued.secret });
  } finally {
    server.close();
    await once(server, 'close');
  }
};

test('the SDK answers the three questions as three methods', async () => {
  await withServer(async (client) => {
    assert.equal(await client.holderAsOf(TOKEN, 120n), ALICE);
    assert.equal(await client.isFinalAsOf(TOKEN, 120n), true);
    assert.equal(await client.openGapOf(TOKEN), null);

    assert.equal(await client.holderAsOf(TOKEN, 130n), BOB);
    assert.equal(await client.isFinalAsOf(TOKEN, 130n), false);
  });
});

test('the SDK exposes no single collapsed status', () => {
  const surface = Object.getOwnPropertyNames(ProjectionClient.prototype);
  for (const forbidden of ['status', 'getStatus', 'state', 'isSettled', 'isConfirmed']) {
    assert.ok(!surface.includes(forbidden), `the client exposes ${forbidden}`);
  }
});

test('resolve returns three labelled facts, not one verdict', async () => {
  await withServer(async (client) => {
    const resolution = await client.resolve(TOKEN, 120n);
    assert.deepEqual(Object.keys(resolution).sort(), ['final', 'holder', 'openGap']);
    assert.equal(resolution.holder, ALICE);
    assert.equal(resolution.final, true);
    assert.equal(resolution.openGap, null);
  });
});

test('uint64 values decode as bigint, never as number', async () => {
  await withServer(async (client) => {
    const first = await client.entryAt(TOKEN, 1n);
    assert.equal(typeof first.version, 'bigint');
    assert.equal(typeof first.effectiveAt, 'bigint');
    assert.equal(typeof first.supersededAt, 'bigint');
    // The closed entry carries the register's own effective time.
    assert.equal(first.supersededAt, 130n);
    assert.equal((await client.entryAt(TOKEN, 2n)).supersededAt, 0n);
  });
});

test('an instant the projection does not cover raises its own error type', async () => {
  await withServer(async (client) => {
    await assert.rejects(() => client.holderAsOf(TOKEN, 99n), NotCoveredError);
    await assert.rejects(() => client.entryAsOf(TOKEN, 99n), NotCoveredError);
    // Finality answers there rather than raising, as the standard requires.
    assert.equal(await client.isFinalAsOf(TOKEN, 99n), false);
  });
});

test('an unknown version surfaces with its code', async () => {
  await withServer(async (client) => {
    await assert.rejects(() => client.entryAt(TOKEN, 9n), (error: unknown) => {
      assert.ok(error instanceof ProjectionClientError);
      assert.equal(error.code, 'UNKNOWN_VERSION');
      assert.equal(error.status, 404);
      return true;
    });
  });
});

test('the SDK reports an open gap without letting it touch finality', async () => {
  await withServer(async (client, h) => {
    const engine = new SettlementEngine({
      store: h.store,
      authority: new AllowListAuthority([ALICE]),
      clock: { now: () => 1_000n },
      settlementPeriod: 86_400n,
    });
    engine.begin({
      tokenId: TOKEN,
      settlementId: commitment(0x5e77),
      initiator: ALICE,
      expectedHolder: BOB,
      snapshotHash: commitment(0x5a),
      deadline: 4_000n,
    });

    const gap = await client.openGapOf(TOKEN);
    assert.equal(gap?.status, 'OPEN');
    assert.equal(gap?.expectedHolder, BOB);
    assert.equal(typeof gap?.openedAt, 'bigint');

    // The gap is open and finality is exactly where it was.
    assert.equal(await client.isFinalAsOf(TOKEN, 120n), true);
    assert.equal(await client.isFinalAsOf(TOKEN, 140n), false);
  });
});

test('the entry walk reads the whole history', async () => {
  await withServer(async (client) => {
    assert.equal(await client.entryCount(TOKEN), 2);
    const all = await client.entries(TOKEN);
    assert.deepEqual(all.map((item) => item.version), [1n, 2n]);
    assert.deepEqual(all.map((item) => item.holder), [ALICE, BOB]);
  });
});

test('the python SDK suite passes', () => {
  // Same guarantees, same wire format, a second language. Runs the Python
  // suite in-process with the repository's own interpreter.
  const output = execFileSync(python, ['-B', 'sdk/python/test_client.py'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /all python sdk checks passed/);
  assert.ok(!output.includes('failed:'), output);
});

test('the client refuses a base URL that would leak credentials', () => {
  for (const baseUrl of ['http://kit.example', 'https://user:pass@kit.example', 'http://10.0.0.5:8080']) {
    assert.throws(() => new ProjectionClient({ baseUrl }), /https|credentials/);
  }
  // Loopback over http stays allowed for development.
  assert.doesNotThrow(() => new ProjectionClient({ baseUrl: 'http://127.0.0.1:8080' }));
  assert.doesNotThrow(() => new ProjectionClient({ baseUrl: 'https://kit.example' }));
});

test('a read that never returns fails instead of hanging', async () => {
  // Resolves only if nothing aborts it, so the assertion is about the signal
  // the client supplies rather than about timing.
  const stalled: HttpLike = (_url, init) =>
    new Promise((resolve, rejectPromise) => {
      const timer = setTimeout(() => resolve({ status: 200, json: async () => ({ holder: 'x' }) }), 60_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        rejectPromise(new Error('aborted by timeout'));
      }, { once: true });
    });

  const client = new ProjectionClient({ baseUrl: 'https://kit.example', fetch: stalled, timeoutMs: 25 });
  await assert.rejects(() => client.holderAsOf(1n, 120n), /aborted by timeout/);
});

test('the client never retries, so no read is duplicated', async () => {
  let calls = 0;
  const counting: HttpLike = async () => {
    calls += 1;
    return { status: 500, json: async () => ({ error: 'BOOM' }) };
  };
  const client = new ProjectionClient({ baseUrl: 'https://kit.example', fetch: counting });
  await assert.rejects(() => client.holderAsOf(1n, 120n));
  // One call, one failure. A retried write could double-submit; this client
  // does not retry at all, so there is nothing to duplicate.
  assert.equal(calls, 1);
});


test('the Python default transport authenticates and reads multi-page history', async () => {
  await withServer(async (_client, h, connection) => {
    for (let i = 3; i <= 205; i++) {
      admit(h, TOKEN, entry({ version: BigInt(i), holder: BOB, effectiveAt: BigInt(100 * i),
        recordCommitment: commitment(i), previousCommitment: commitment(i - 1) }));
    }
    admit(h, 1n << 200n, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
    const code = `import os, sys
sys.path.insert(0, 'sdk/python')
from erc8415 import ProjectionClient, ProjectionClientError
url = os.environ['KIT_TEST_URL']
try:
    ProjectionClient(url).holder_as_of(1, 120)
    raise AssertionError('unauthenticated read succeeded')
except ProjectionClientError as error:
    assert error.status == 401
client = ProjectionClient(url, api_key=os.environ['KIT_TEST_KEY'])
assert client.holder_as_of(1, 120) == '${ALICE}'
assert client.resolve(1, 120).final is True
assert [row.version for row in client.entries(1)] == list(range(1, 206))
assert client.entries(999) == []
assert client.holder_as_of(1 << 200, 100) == '${ALICE}'
print('authenticated')`;
    const { stdout } = await promisify(execFile)(python, ['-B', '-c', code], {
      cwd: root, env: { ...process.env, KIT_TEST_URL: connection.baseUrl, KIT_TEST_KEY: connection.apiKey },
    });
    assert.match(stdout, /authenticated/);
  });
});


test('resolve takes one snapshot and observes later admissions only on a new call', async () => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  let calls = 0;
  const client = new ProjectionClient({ baseUrl: 'https://kit.example', fetch: async (url) => {
    calls++;
    const response = handle(h.store, { method: 'GET', path: new URL(url).pathname });
    if (calls === 1) {
      admit(h, TOKEN, entry({ version: 2n, holder: BOB, effectiveAt: 130n, recordCommitment: commitment(2), previousCommitment: commitment(1) }));
      admit(h, TOKEN, entry({ version: 3n, holder: BOB, effectiveAt: 170n, recordCommitment: commitment(3), previousCommitment: commitment(2) }));
    }
    return { status: response.status, json: async () => response.body };
  } });
  assert.deepEqual(await client.resolve(TOKEN, 150n), { holder: ALICE, final: false, openGap: null });
  assert.equal(calls, 1);
  assert.deepEqual(await client.resolve(TOKEN, 150n), { holder: BOB, final: true, openGap: null });
  await assert.rejects(() => client.resolve(TOKEN, 99n), NotCoveredError);
});


test('the JS entry walk returns every page and handles an empty history', async () => {
  await withServer(async (client, h) => {
    for (let i = 3; i <= 205; i++) {
      admit(h, TOKEN, entry({ version: BigInt(i), holder: BOB, effectiveAt: BigInt(100 * i),
        recordCommitment: commitment(i), previousCommitment: commitment(i - 1) }));
    }
    assert.deepEqual((await client.entries(TOKEN)).map((row) => row.version),
      Array.from({ length: 205 }, (_, i) => BigInt(i + 1)));
    assert.deepEqual(await client.entries(999n), []);
  });
});

test('the entry walk fails explicitly if a page ends before the reported count', async () => {
  const client = new ProjectionClient({ baseUrl: 'https://kit.example', fetch: async () => ({
    status: 200, json: async () => ({ offset: 0, entryCount: 5, entries: [] }),
  }) });
  await assert.rejects(() => client.entries(TOKEN), (error: unknown) =>
    error instanceof ProjectionClientError && error.code === 'INVALID_PAGE');
});


test('the JS SDK preserves the full uint256 token identifier', async () => {
  await withServer(async (client, h) => {
    const tokenId = (1n << 256n) - 1n;
    admit(h, tokenId, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
    assert.equal(await client.holderAsOf(tokenId, 100n), ALICE);
    assert.equal((await client.entries(tokenId)).length, 1);
  });
});
