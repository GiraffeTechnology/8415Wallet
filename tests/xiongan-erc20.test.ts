import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalAssetSession, formatTokenUnits, parseAssetState, type AssetState, type AssetStore } from '../src/xiongan/externalAssets.ts';
import { encodeCall } from '../src/codec/abi.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`;
const blockHash = `0x${'4'.repeat(64)}`, transactionHash = `0x${'5'.repeat(64)}`, foreignHash = `0x${'6'.repeat(64)}`;
const checksum = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
function stringAbi(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  return `${word(32n)}${word(BigInt(bytes.length)).slice(2)}${bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')}`;
}
type RpcArgs = { method: string; params?: readonly unknown[] };
function fixture(chain = '1') {
  let state: AssetState | null = null, sends = 0, sent: Record<string, string> | null = null;
  const flags = { code: '0x6000', balance: word(9_007_199_254_740_993_000_000n), name: stringAbi('Token name'), symbol: stringAbi('TOK'),
    decimals: word(6n), returned: word(1n), nonce: '0x0', sendError: null as unknown, missingMetadata: false,
    callError: false, receipt: true, reorg: false, omitEvent: false, status: '0x1', eventAmount: null as string | null,
    eventBlockHash: blockHash, eventBlockNumber: '0x64', eventIndex: '0x0', eventFrom: actor, eventRecipient: recipient, eventContract: contract, eventHash: transactionHash, removed: false };
  const store: AssetStore = { async read() { return structuredClone(state); }, async compareAndSwap(expected, next) {
    if ((state?.revision ?? null) !== expected) return false;
    state = parseAssetState(JSON.stringify(next)); return true;
  } };
  const calls: RpcArgs[] = [];
  const provider = { async request({ method, params = [] }: RpcArgs): Promise<unknown> {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'eth_chainId') return `0x${BigInt(chain).toString(16)}`;
    if (method === 'eth_accounts') return [actor];
    if (method === 'eth_getCode') return params[0] === actor || params[0] === recipient ? '0x' : flags.code;
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x3e8', hash: flags.reorg ? foreignHash : blockHash };
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getTransactionCount') return flags.nonce;
    if (method === 'eth_estimateGas') return '0xc350';
    if (method === 'eth_call') {
      if (flags.callError) throw new Error('private endpoint details');
      const data = (params[0] as { data: string }).data;
      if (data.startsWith('0x70a08231')) return flags.balance;
      if (data.startsWith('0xa9059cbb')) return flags.returned;
      if (flags.missingMetadata) throw new Error('method absent');
      if (data === encodeCall('name()', [], [])) return flags.name;
      if (data === encodeCall('symbol()', [], [])) return flags.symbol;
      if (data === encodeCall('decimals()', [], [])) return flags.decimals;
      throw new Error('Unexpected method: ERC-20 does not require ERC-165');
    }
    if (method === 'eth_sendTransaction') {
      sends++; sent = structuredClone(params[0]) as Record<string, string>;
      if (flags.sendError !== null) throw flags.sendError;
      return transactionHash;
    }
    if (method === 'eth_getTransactionByHash') return { ...sent, hash: transactionHash, input: sent!.data, blockHash, blockNumber: '0x64', transactionIndex: '0x0' };
    if (method === 'eth_getTransactionReceipt') return flags.receipt ? {
      transactionHash, from: actor, to: sent!.to, transactionIndex: '0x0', blockNumber: '0x64', blockHash, status: flags.status,
      logs: flags.omitEvent ? [] : [{ address: flags.eventContract, transactionHash: flags.eventHash, blockHash: flags.eventBlockHash,
        blockNumber: flags.eventBlockNumber, transactionIndex: flags.eventIndex, removed: flags.removed,
        topics: [keccak256Utf8('Transfer(address,address,uint256)'), `0x${'0'.repeat(24)}${flags.eventFrom.slice(2)}`, `0x${'0'.repeat(24)}${flags.eventRecipient.slice(2)}`],
        data: flags.eventAmount ?? `0x${sent!.data!.slice(74, 138)}` }],
    } : null;
    throw new Error(`unexpected ${method}`);
  } };
  const create = () => new ExternalAssetSession(provider, chain, actor, store);
  const request = (changes: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => JSON.stringify({
    schema: 'xiongan-asset-request/1', requestId: 'erc20-request', agent: 'Token transfer', chainId: chain,
    actor, expiresAt: '1500', action: { kind: 'erc20-transfer', recipient, contract, amount: '1234567', ...changes }, ...root,
  });
  return { flags, store, provider, calls, create, request, sends: () => sends };
}
for (const chain of ['1', '8453', '11155111', '84532']) test(`ERC-20 chain ${chain}: exact address, metadata and balance without ERC-165`, async () => {
  const f = fixture(chain), s = f.create(), balance = await s.erc20Balance(contract);
  assert.equal(balance.chainId, chain); assert.equal(balance.contract, contract);
  assert.equal(balance.balanceRaw, '9007199254740993000000'); assert.equal(balance.displayBalance, '9007199254740993');
  assert.deepEqual(balance.metadata, { name: 'Token name', symbol: 'TOK', decimals: 6 });
  assert.equal(f.sends(), 0);
  assert.ok(f.calls.filter(c => c.method === 'eth_call').every(c => c.params?.[1] === '0x64'));
  const r = await s.prepare(f.request()); assert.equal(r.displayAmount, '1.234567'); assert.equal(r.amount, '1234567');
  assert.equal(r.asset, 'ERC-20'); assert.equal(r.transaction.to, contract); assert.equal(r.transaction.value, '0x0');
  assert.equal(r.transaction.data, encodeCall('transfer(address,uint256)', ['address', 'uint256'], [recipient, 1_234_567n]));
  assert.ok(Object.isFrozen(r.tokenMetadata)); assert.ok(Object.isFrozen(r.transaction)); assert.ok(Object.isFrozen(r));
  await s.submit(r, r.digest); assert.equal((await s.reconcile()).state, 'confirmed');
  await s.acknowledge(); assert.equal((await s.status()).status, 'idle'); assert.equal(f.sends(), 1);
});
test('ERC-20 unit formatting is lossless for zero, unusual and uint8 maximum decimals', () => {
  assert.equal(formatTokenUnits('1234567', 6), '1.234567');
  assert.equal(formatTokenUnits('1234567890123456789', 18), '1.234567890123456789'); assert.equal(formatTokenUnits('1', 0), '1');
  assert.equal(formatTokenUnits('0', 255), '0'); assert.equal(formatTokenUnits('1', 255), `0.${'0'.repeat(254)}1`);
  assert.equal(formatTokenUnits('9007199254740993000001', 6), '9007199254740993.000001');
  for (const decimals of [-1, 256, NaN, 1.5, Infinity]) assert.throws(() => formatTokenUnits('1', decimals));
});
for (const returned of ['0x', word(1n)]) test(`ERC-20 transfer simulation accepts ${returned === '0x' ? 'legacy empty' : 'canonical true'} only`, async () => {
  const f = fixture(); f.flags.returned = returned; assert.equal((await f.create().prepare(f.request())).asset, 'ERC-20'); assert.equal(f.sends(), 0);
});
for (const returned of [word(0n), word(2n), '0x01', `${word(1n)}00`, '0xzz', '', { result: word(1n) }]) test(`ERC-20 malformed or false transfer result ${JSON.stringify(returned)} refuses`, async () => {
  const f = fixture(); f.flags.returned = returned as string;
  await assert.rejects(f.create().prepare(f.request()), /ASSET_ERC20_TRANSFER_RETURN_REFUSED/); assert.equal(f.sends(), 0);
});
for (const balance of ['0x', '0x01', `${word(10n)}00`, 'not-hex', word(1n)]) test(`ERC-20 malformed or insufficient balance ${balance} refuses`, async () => {
  const f = fixture(); f.flags.balance = balance;
  await assert.rejects(f.create().prepare(f.request()), /ASSET_ERC20_BALANCE_(REFUSED|INSUFFICIENT)/);
  if (balance !== word(1n)) await assert.rejects(f.create().erc20Balance(contract), /ASSET_ERC20_BALANCE_REFUSED/);
  assert.equal(f.sends(), 0);
});
test('ERC-20 missing optional metadata supports explicit raw units without assuming 18 decimals', async () => {
  const f = fixture(); f.flags.missingMetadata = true;
  const balance = await f.create().erc20Balance(contract); assert.equal(balance.displayBalance, null);
  assert.deepEqual(balance.metadata, { name: null, symbol: null, decimals: null });
  const review = await f.create().prepare(f.request()); assert.equal(review.displayAmount, null); assert.equal(review.amount, '1234567');
  await f.create().submit(review, review.digest); assert.equal(f.sends(), 1);
});
for (const decimals of ['0x', word(256n), '0x12', `${word(18n)}00`]) test(`ERC-20 invalid optional decimals ${decimals} remain unknown`, async () => {
  const f = fixture(); f.flags.decimals = decimals;
  const r = await f.create().prepare(f.request()); assert.equal(r.tokenMetadata?.decimals, null); assert.equal(r.displayAmount, null);
});
for (const name of [word(0n), stringAbi('a'.repeat(129)), stringAbi('bad\u202Ename'), stringAbi('bad\nname'), stringAbi(''),
  `${stringAbi('Valid')}00`, `${word(32n)}${word(1n).slice(2)}ff${'0'.repeat(62)}`]) test('ERC-20 malformed or unsafe optional token text is unavailable', async () => {
  const f = fixture(); f.flags.name = name; f.flags.symbol = name;
  const r = await f.create().prepare(f.request()); assert.equal(r.tokenMetadata?.name, null); assert.equal(r.tokenMetadata?.symbol, null);
});
test('ERC-20 metadata supports bounded valid UTF-8, but remains untrusted display data', async () => {
  const f = fixture(); f.flags.name = stringAbi('Token 💠'); f.flags.symbol = stringAbi('<TOK>');
  const r = await f.create().prepare(f.request()); assert.equal(r.tokenMetadata?.name, 'Token 💠'); assert.equal(r.tokenMetadata?.symbol, '<TOK>');
});
for (const change of [ { nonce: '0x1' }, { code: '0x6001' }, { decimals: word(18n) }, { symbol: stringAbi('CHANGED') } ]) test(`ERC-20 fresh immutable review rejects changed ${Object.keys(change)[0]}`, async () => {
  const f = fixture(), s = f.create(), review = await s.prepare(f.request()); Object.assign(f.flags, change);
  await assert.rejects(s.submit(review, review.digest), /ASSET_REVIEW_CHANGED/); assert.equal(f.sends(), 0);
});
test('ERC-20 mutated review metadata cannot authorize a different display amount', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request());
  await assert.rejects(s.submit({ ...r, tokenMetadata: { ...r.tokenMetadata!, decimals: 18 } }, r.digest), /ASSET_REVIEW_CHANGED/);
  assert.equal(f.sends(), 0);
});
for (const change of [{ omitEvent: true }, { eventAmount: word(1_234_566n) }, { eventFrom: contract }, { eventRecipient: actor },
  { eventContract: actor }, { eventHash: foreignHash }, { eventBlockHash: foreignHash }, { eventBlockNumber: '0x63' }, { eventIndex: '0x1' }, { removed: true }]) test(`ERC-20 noncanonical/mismatched effect ${Object.keys(change)[0]} remains unresolved`, async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); await s.submit(r, r.digest); Object.assign(f.flags, change);
  await assert.rejects(s.reconcile(), /ASSET_ERC20_EFFECT_UNOBSERVED/); await assert.rejects(s.acknowledge(), /ASSET_ERC20_EFFECT_UNOBSERVED/);
  assert.equal((await s.status()).status, 'submitted'); assert.equal(f.sends(), 1);
});
test('ERC-20 reverted transaction is terminal without claiming a transfer', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); await s.submit(r, r.digest);
  f.flags.status = '0x0'; f.flags.omitEvent = true; assert.equal((await s.reconcile()).state, 'reverted'); await s.acknowledge();
  assert.equal((await s.status()).status, 'idle');
});
test('ERC-20 explicit provider rejection clears durably, reload and new review permit one later attempt', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); f.flags.sendError = { code: 4001 };
  await assert.rejects(s.submit(r, r.digest), /CONTROL_PROVIDER_REQUEST_REJECTED/); assert.equal((await f.create().status()).status, 'idle');
  f.flags.sendError = null; const next = f.create(), fresh = await next.prepare(f.request()); await next.submit(fresh, fresh.digest);
  await next.acknowledge(); assert.equal(f.sends(), 2);
});
test('ERC-20 unknown outcome survives reload, blocks repeats and recovers exact mined transfer', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); f.flags.sendError = new Error('connection lost after broadcast');
  await assert.rejects(s.submit(r, r.digest), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/);
  const next = f.create(); assert.equal((await next.status()).status, 'outcome-unknown');
  await assert.rejects(next.submit(r, r.digest), /ASSET_RECONCILIATION_REQUIRED/);
  f.flags.receipt = false; await assert.rejects(next.recover(transactionHash), /ASSET_RECOVERY_BINDING_UNOBSERVED/);
  f.flags.receipt = true; f.flags.eventAmount = word(1n); await assert.rejects(next.recover(transactionHash), /ASSET_ERC20_EFFECT_UNOBSERVED/);
  f.flags.eventAmount = null; assert.equal((await next.recover(transactionHash)).state, 'confirmed'); await next.acknowledge(); assert.equal(f.sends(), 1);
});
test('ERC-20 checksum, chain, amount and schema boundaries refuse before any send', async () => {
  const f = fixture(), s = f.create(), bad = checksum.slice(0, -1) + 'c';
  for (const changes of [{ contract: bad }, { recipient: bad }, { recipient: actor }, { contract: `0x${'0'.repeat(40)}` },
    { amount: '0' }, { amount: '1.2' }, { amount: 1 }, { amount: '01' }, { amount: '1e18' }, { amount: (1n << 256n).toString() },
    { data: '0x095ea7b3' }, { spender: recipient }, { kind: 'approve' }]) await assert.rejects(s.prepare(f.request(changes)));
  await assert.rejects(s.prepare(f.request({}, { chainId: '56' })), /ASSET_CHAIN_UNSUPPORTED/);
  await assert.rejects(s.prepare(f.request({}, { chainId: '8453' })), /ASSET_REQUEST_BINDING_REFUSED/);
  await assert.rejects(s.erc20Balance(bad), /ASSET_ADDRESS_REFUSED/); assert.equal(f.sends(), 0);
});
test('ERC-20 valid checksum input normalizes after validation', async () => {
  const f = fixture(), s = f.create();
  for (const recipient of [checksum, checksum.toLowerCase(), `0x${checksum.slice(2).toUpperCase()}`])
    assert.equal((await s.prepare(f.request({ recipient }))).recipient, checksum.toLowerCase());
  for (const contract of [checksum, checksum.toLowerCase(), `0x${checksum.slice(2).toUpperCase()}`])
    assert.equal((await s.prepare(f.request({ contract }))).transaction.to, checksum.toLowerCase());
});
test('ERC-20 read transport failure is unavailable, never a zero token balance', async () => {
  const f = fixture(); f.flags.callError = true;
  await assert.rejects(f.create().erc20Balance(contract), /CONTROL_RPC_REFUSED/);
  await assert.rejects(f.create().prepare(f.request()), /CONTROL_RPC_REFUSED/); assert.equal(f.sends(), 0);
});
test('ERC-20 repeated concurrent sessions issue at most one wallet prompt', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); await s.status();
  const results = await Promise.allSettled([s.submit(r, r.digest), f.create().submit(r, r.digest)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.sends(), 1);
});
test('ERC-20 provider cannot mutate the pinned review through simulation parameters', async () => {
  const f = fixture(), provider = { async request(args: RpcArgs) {
    if (args.method === 'eth_call' && (args.params?.[0] as { data?: string })?.data?.startsWith('0xa9059cbb')) {
      (args.params![0] as Record<string, unknown>).nonce = '0xffff';
    }
    return f.provider.request(args);
  } };
  const s = new ExternalAssetSession(provider, '1', actor, f.store), r = await s.prepare(f.request());
  assert.equal(r.transaction.nonce, '0x0'); await s.submit(r, r.digest); assert.equal(f.sends(), 1);
});

test('ERC-20 balance dropping below reviewed amount prevents a later prompt', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); f.flags.balance = word(1n);
  await assert.rejects(s.submit(r, r.digest), /ASSET_ERC20_BALANCE_INSUFFICIENT/); assert.equal(f.sends(), 0);
});
test('ERC-20 nonzero string padding is not interpreted as metadata', async () => {
  const f = fixture(); f.flags.name = stringAbi('Valid').slice(0, -1) + '1';
  assert.equal((await f.create().erc20Balance(contract)).metadata.name, null);
});
test('ERC-20 reorged receipt cannot be acknowledged or automatically resent', async () => {
  const f = fixture(), s = f.create(), r = await s.prepare(f.request()); await s.submit(r, r.digest); f.flags.reorg = true;
  assert.equal((await s.reconcile()).state, 'reorged'); await assert.rejects(s.acknowledge(), /ASSET_TERMINAL_RECEIPT_REQUIRED/);
  assert.equal((await s.status()).status, 'submitted'); assert.equal(f.sends(), 1);
});
