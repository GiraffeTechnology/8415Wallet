import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalAssetSession, parseAssetState, type AssetState, type AssetStore } from '../src/xiongan/externalAssets.ts';
import { encodeCall } from '../src/codec/abi.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, nft = `0x${'3'.repeat(40)}`;
const blockHash = `0x${'4'.repeat(64)}`, transactionHash = `0x${'5'.repeat(64)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture(chainId = '1', guard: () => void = () => {}) {
  let record: AssetState | null = null, sends = 0, nonce = 0n, failSend = false, pending = false, wrongTx = false, reorg = false, omitEffect = false, account = actor;
  let sent: Record<string, string> | null = null;
  const store: AssetStore = { async read() { return structuredClone(record); }, async compareAndSwap(expected, next) {
    if ((record?.revision ?? null) !== expected) return false; record = parseAssetState(JSON.stringify(next)); return true;
  } };
  const provider = { async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    if (method === 'eth_chainId') return `0x${BigInt(chainId).toString(16)}`;
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_getCode') return params[0] === nft ? '0x6000' : '0x';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x3e8', hash: reorg ? `0x${'9'.repeat(64)}` : blockHash };
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getBalance') return '0x100000';
    if (method === 'eth_getTransactionCount') return `0x${nonce.toString(16)}`;
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_call') {
      const data = (params[0] as { data: string }).data;
      if (data === encodeCall('supportsInterface(bytes4)', ['bytes4'], ['0xffffffff'])) return word(0n);
      if (data.startsWith('0x01ffc9a7')) return word(1n);
      if (data.startsWith('0x6352211e')) return `0x${'0'.repeat(24)}${actor.slice(2)}`;
      return word(10n);
    }
    if (method === 'eth_sendTransaction') { sends++; sent = params[0] as Record<string, string>; if (failSend) throw new Error('private provider endpoint'); return transactionHash; }
    if (method === 'eth_getTransactionByHash') return { ...sent, from: wrongTx ? recipient : actor, input: sent!.data, hash: transactionHash, blockHash, blockNumber: '0x64', transactionIndex: '0x0' };
    if (method === 'eth_getTransactionReceipt') {
      if (pending) return null;
      const data = sent!.data!, is721 = data.startsWith('0x42842e0e');
      const logs = data === '0x' || omitEffect ? [] : [{ address: nft, transactionHash, blockHash, blockNumber: '0x64', transactionIndex: '0x0', removed: false, data: is721 ? '0x' : `0x${data.slice(138, 266)}`,
        topics: is721 ? [keccak256Utf8('Transfer(address,address,uint256)'), `0x${'0'.repeat(24)}${actor.slice(2)}`, `0x${data.slice(74, 138)}`, `0x${data.slice(138, 202)}`] :
          [keccak256Utf8('TransferSingle(address,address,address,uint256,uint256)'), `0x${'0'.repeat(24)}${actor.slice(2)}`, `0x${'0'.repeat(24)}${actor.slice(2)}`, `0x${data.slice(74, 138)}`] }];
      return { transactionHash, from: actor, to: sent!.to, transactionIndex: '0x0', blockNumber: '0x64', blockHash, status: '0x1', logs };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const session = () => new ExternalAssetSession(provider, chainId, actor, store, guard);
  const request = (action: unknown = { kind: 'native-transfer', recipient, valueWei: '1000' }, changes: Record<string, unknown> = {}) => JSON.stringify({
    schema: 'xiongan-asset-request/1', requestId: 'request-1', agent: 'Xiongan', chainId, actor, expiresAt: '1500', action, ...changes });
  return { session, request, provider, store, sends: () => sends, record: () => record,
    change: (flags: { failSend?: boolean; pending?: boolean; wrongTx?: boolean; reorg?: boolean; omitEffect?: boolean; nonce?: bigint; account?: string }) => {
      if (flags.failSend !== undefined) failSend = flags.failSend; if (flags.pending !== undefined) pending = flags.pending;
      if (flags.wrongTx !== undefined) wrongTx = flags.wrongTx; if (flags.reorg !== undefined) reorg = flags.reorg;
      if (flags.omitEffect !== undefined) omitEffect = flags.omitEffect; if (flags.nonce !== undefined) nonce = flags.nonce;
      if (flags.account !== undefined) account = flags.account;
    } };
}
for (const chain of ['1', '8453', '11155111', '84532']) test(`external EOA ${chain}: exact ETH review, one wallet request, receipt and acknowledgement`, async () => {
  const f = fixture(chain), s = f.session(); const balance = await s.balance(); assert.equal(balance.chainId, chain);
  const review = await s.prepare(f.request()); assert.equal(f.sends(), 0); assert.equal(review.transaction.to, recipient);
  await s.submit(review, review.digest); assert.equal(f.sends(), 1); assert.equal((await s.reconcile()).state, 'confirmed');
  await s.acknowledge(); assert.equal((await s.status()).status, 'idle'); assert.equal(f.sends(), 1);
});
for (const kind of ['erc721-transfer', 'erc1155-transfer']) test(`${kind} validates ownership and matching transfer event without approvals`, async () => {
  const f = fixture(), s = f.session(); const review = await s.prepare(f.request({ kind, recipient, contract: nft, tokenId: '7', ...(kind === 'erc1155-transfer' ? { amount: '3' } : {}) }));
  await s.submit(review, review.digest); assert.equal((await s.reconcile()).state, 'confirmed');
  f.change({ omitEffect: true }); await assert.rejects(s.reconcile(), /ASSET_NFT_EFFECT_UNOBSERVED/);
});
test('unknown send survives restart, blocks duplicates, recovers only exact mined hash', async () => {
  const f = fixture(), s = f.session(); const review = await s.prepare(f.request()); f.change({ failSend: true });
  await assert.rejects(s.submit(review, review.digest), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/);
  assert.equal((await s.status()).status, 'outcome-unknown'); assert.equal(f.sends(), 1);
  const restarted = f.session(); await assert.rejects(restarted.submit(review, review.digest), /ASSET_RECONCILIATION_REQUIRED/);
  f.change({ pending: true }); await assert.rejects(restarted.recover(transactionHash), /ASSET_RECOVERY_BINDING_UNOBSERVED/);
  f.change({ pending: false, wrongTx: true }); await assert.rejects(restarted.recover(transactionHash), /ASSET_TRANSACTION_BINDING_REFUSED/);
  f.change({ wrongTx: false }); assert.equal((await restarted.recover(transactionHash)).state, 'confirmed');
  await restarted.acknowledge(); assert.equal(f.sends(), 1); assert.equal((await restarted.status()).status, 'idle');
});
test('reorg prevents terminal acknowledgement and keeps submitted journal', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request()); await s.submit(r, r.digest);
  f.change({ reorg: true }); assert.equal((await s.reconcile()).state, 'reorged');
  await assert.rejects(s.acknowledge(), /ASSET_TERMINAL_RECEIPT_REQUIRED/); assert.equal((await s.status()).status, 'submitted');
});
test('nonce and account changes invalidate reviewed transaction before prompting', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request()); f.change({ nonce: 1n });
  await assert.rejects(s.submit(r, r.digest), /ASSET_REVIEW_CHANGED/); assert.equal(f.sends(), 0);
  f.change({ nonce: 0n, account: recipient }); await assert.rejects(s.submit(r, r.digest), /ASSET_ACCOUNT_CHANGED/); assert.equal(f.sends(), 0);
});
test('arbitrary calldata, signatures, unsupported operations and expired requests are refused', async () => {
  const f = fixture(), s = f.session();
  for (const text of [f.request(undefined, { signature: 'secret' }), f.request({ kind: 'approve', recipient }), f.request(undefined, { expiresAt: '999' }),
    f.request(undefined, { expiresAt: '1901' }), f.request(undefined, { chainId: '56' }), f.request(undefined, { actor: recipient }),
    f.request({ kind: 'native-transfer', recipient, valueWei: 1000 }), f.request({ kind: 'native-transfer', recipient, valueWei: '-1' }),
    f.request({ kind: 'native-transfer', recipient: nft, valueWei: '1000' }), f.request({ kind: 'native-transfer', recipient, valueWei: '0', data: '0xff' })]) {
    await assert.rejects(s.prepare(text));
  }
  assert.equal(f.sends(), 0);
});
test('missing owner digest and altered transaction review cannot authorize a prompt', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request());
  await assert.rejects(s.submit(r, '0x00'), /ASSET_OWNER_REVIEW_REQUIRED/);
  const changed = { ...r, requestText: f.request({ kind: 'native-transfer', recipient, valueWei: '1001' }) };
  await assert.rejects(s.submit(changed, r.digest), /ASSET_REVIEW_CHANGED/); assert.equal(f.sends(), 0);
});
test('two sessions sharing a journal allow at most one submit', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request()); await s.status();
  const results = await Promise.allSettled([s.submit(r, r.digest), f.session().submit(r, r.digest)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.sends(), 1);
});
test('malformed journal state fails closed rather than implying idle', () => {
  for (const state of [{}, { schema: 'xiongan-asset-operation/1', revision: 0, chainId: '1', actor, status: 'idle', transaction: null, transactionHash, digest: null }])
    assert.throws(() => parseAssetState(JSON.stringify(state)));
});

test('displayed review fields cannot diverge from the transaction submitted', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request());
  assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.transaction));
  const changed = { ...r, recipient: nft, amount: '999', transaction: { ...r.transaction, to: nft } };
  await assert.rejects(s.submit(changed, r.digest), /ASSET_REVIEW_CHANGED/); assert.equal(f.sends(), 0);
});
test('same-intent speed-up hash may recover an already submitted operation', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request()); await s.submit(r, r.digest);
  assert.equal((await s.recover(transactionHash)).state, 'confirmed'); assert.equal(f.sends(), 1);
});
test('a matching intent cannot be cleared as a different nonce replacement', async () => {
  const f = fixture(), s = f.session(), r = await s.prepare(f.request()); await s.submit(r, r.digest);
  await assert.rejects(s.acknowledgeReplacement(transactionHash), /ASSET_SAVED_HASH_NOT_A_REPLACEMENT/);
  assert.equal((await s.status()).status, 'submitted');
});

test('generation invalidation before submit prevents any provider send even if account returns', async () => {
  let current = true;
  const f = fixture('1', () => { if (!current) throw new Error('connection generation changed'); }), s = f.session();
  const r = await s.prepare(f.request()); current = false;
  await assert.rejects(s.submit(r, r.digest)); assert.equal(f.sends(), 0); assert.equal((await s.status()).status, 'idle');
});
test('pre-send guard failure after reservation clears only the provably unsent intent', async () => {
  const f = fixture(), s = new ExternalAssetSession(f.provider, '1', actor, f.store, () => {
    if (f.record()?.status === 'outcome-unknown') throw new Error('connection revoked before send');
  });
  const r = await s.prepare(f.request()); await assert.rejects(s.submit(r, r.digest));
  assert.equal(f.sends(), 0); assert.equal((await s.status()).status, 'idle');
});
test('late canonical block change prevents acknowledgement from clearing the journal', async () => {
  const f = fixture(), provider = { async request(args: { method: string; params?: readonly unknown[] }) {
    const value = await f.provider.request(args); if (args.method === 'eth_blockNumber') f.change({ reorg: true }); return value;
  } }, s = new ExternalAssetSession(provider, '1', actor, f.store), r = await s.prepare(f.request());
  await s.submit(r, r.digest); assert.equal((await s.reconcile()).state, 'reorged');
  await assert.rejects(s.acknowledge(), /ASSET_TERMINAL_RECEIPT_REQUIRED/); assert.equal((await s.status()).status, 'submitted');
});
test('foreign transaction or block metadata on a matching NFT event is refused', async () => {
  const f = fixture(), provider = { async request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    const value = await f.provider.request(args);
    if (args.method === 'eth_getTransactionReceipt') (value as any).logs[0].transactionHash = `0x${'9'.repeat(64)}`;
    return value;
  } }, s = new ExternalAssetSession(provider, '1', actor, f.store), r = await s.prepare(f.request({ kind: 'erc721-transfer', recipient, contract: nft, tokenId: '7' }));
  await s.submit(r, r.digest); await assert.rejects(s.reconcile(), /ASSET_NFT_EFFECT_UNOBSERVED/);
});
test('canonical same-nonce cancellation unlocks but never claims original success', async () => {
  const f = fixture(), provider = { async request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    const value = await f.provider.request(args);
    if (args.method === 'eth_getTransactionByHash') return { ...(value as object), hash: `0x${'6'.repeat(64)}`, to: actor, value: '0x0', input: '0x' };
    if (args.method === 'eth_getTransactionReceipt') return { ...(value as object), transactionHash: `0x${'6'.repeat(64)}`, to: actor };
    return value;
  } }, s = new ExternalAssetSession(provider, '1', actor, f.store), r = await s.prepare(f.request());
  await s.submit(r, r.digest); assert.equal((await s.acknowledgeReplacement(`0x${'6'.repeat(64)}`)).originalOutcome, 'superseded-not-successful');
  assert.equal((await s.status()).status, 'idle'); assert.equal(f.sends(), 1);
});
