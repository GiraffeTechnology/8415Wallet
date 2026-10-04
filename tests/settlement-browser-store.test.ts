import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { parseSettlementState as parseOperation, serializeSettlementState as serializeOperation } from '../src/wallet/standaloneSettlement.ts';

// Transaction-event contract fixture, NOT a genuine browser/IndexedDB test.
const source = readFileSync(new URL('../web/settlement-store.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/, '').replace('export class', 'class');
const state = { schema: '8415-settlement-operation/1', revision: 0n, status: 'idle',
  deployment: { chainId: 560048n, controller: `0x${'1'.repeat(40)}`, runtimeCodeHash: hashControlBytes('0x6000') },
  actor: `0x${'2'.repeat(40)}`, requestDigest: null, submission: null };
function fixture(options: { relaxed?: boolean; abort?: boolean; legacy?: boolean } = {}) {
  let record: string | undefined, completed = 0, writes = 0, aborted = false;
  const db = { close() {}, transaction(_store: string, mode: string, durability?: { durability: string }) {
    if (mode === 'readwrite') assert.equal(durability?.durability, 'strict');
    let pending: string | undefined;
    const tx: any = { durability: options.relaxed ? 'relaxed' : 'strict',
      abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
      objectStore() { return {
        get() {
          const request: any = { result: record };
          queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => {
            if (aborted || options.abort) { tx.onabort?.(); return; }
            if (pending !== undefined) record = pending;
            completed++; tx.oncomplete?.();
          }); });
          return request;
        },
        put(text: string) { writes++; pending = text; },
      }; },
    };
    return tx;
  } };
  const indexedDB = { open() { const r: any = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
  const factory = new Function('parseOperation', 'serializeOperation', 'globalThis', 'indexedDB', 'localStorage',
    `${source}\nreturn BrowserSettlementStore;`);
  const Store = factory(parseOperation, serializeOperation, { indexedDB, isSecureContext: true }, indexedDB,
    { getItem: () => options.legacy ? 'legacy-record' : null });
  return { store: new Store(560048n, state.deployment.controller, state.actor), stats: () => ({ completed, writes, record }) };
}
test('browser CAS resolves only after strict durable transaction completion and roundtrips', async () => {
  const { store, stats } = fixture();
  assert.equal(await store.compareAndSwap(null, state), true); assert.equal(stats().completed, 1);
  assert.deepEqual(await store.read(), state);
  assert.equal(await store.compareAndSwap(null, state), false); assert.equal(stats().writes, 1);
});
test('browser relaxed durability and post-write transaction abort never authorize a send', async () => {
  const relaxed = fixture({ relaxed: true });
  await assert.rejects(relaxed.store.compareAndSwap(null, state), /CONTROL_BROWSER_DURABILITY_REQUIRED/);
  assert.equal(relaxed.stats().writes, 0);
  const failed = fixture({ abort: true });
  await assert.rejects(failed.store.compareAndSwap(null, state), /CONTROL_JOURNAL_COMMIT_REFUSED/);
  assert.equal(failed.stats().record, undefined);
});
test('legacy browser journal is not silently discarded during durability upgrade', async () => {
  const { store, stats } = fixture({ legacy: true });
  await assert.rejects(store.read(), /CONTROL_LEGACY_JOURNAL_RECONCILIATION_REQUIRED/);
  await assert.rejects(store.compareAndSwap(null, state), /CONTROL_LEGACY_JOURNAL_RECONCILIATION_REQUIRED/);
  assert.equal(stats().writes, 0);
});
