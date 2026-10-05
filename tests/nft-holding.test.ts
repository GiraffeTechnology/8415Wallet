import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalAssetSession, type AssetStore, type NftStandard } from '../src/xiongan/externalAssets.ts';
import { encodeCall } from '../src/codec/abi.ts';
import { hashControlBytes } from '../src/controls/authorization.ts';

const actor = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`;
const blockHash = `0x${'4'.repeat(64)}`, otherHash = `0x${'5'.repeat(64)}`;
const checksum = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const maxUint256 = (1n << 256n) - 1n;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const addressWord = (value: string) => `0x${'0'.repeat(24)}${value.slice(2)}`;
const standards: readonly NftStandard[] = ['ERC-721', 'ERC-1155'];
const interfaceCall = (id: string) => encodeCall('supportsInterface(bytes4)', ['bytes4'], [id]);
const ownerCall = (tokenId: string) => encodeCall('ownerOf(uint256)', ['uint256'], [BigInt(tokenId)]);
const balanceCall = (tokenId: string) => encodeCall('balanceOf(address,uint256)', ['address', 'uint256'], [actor, BigInt(tokenId)]);
type RpcArgs = { method: string; params?: readonly unknown[] };

function fixture(chainId = '1') {
  let journalReads = 0, journalWrites = 0, actorReads = 0;
  const calls: RpcArgs[] = [];
  const flags = {
    chain: `0x${BigInt(chainId).toString(16)}` as unknown, accounts: [actor] as unknown, actorCode: '0x' as unknown,
    code: '0x6000' as unknown, owner: addressWord(actor) as unknown, balance: word(9_007_199_254_740_993n) as unknown,
    header: { number: '0x64', hash: blockHash } as unknown, recheck: { number: '0x64', hash: blockHash } as unknown,
    interfaces: new Map<string, unknown>(), failMethod: '', failData: '', connected: true,
    afterHolding: () => {}, afterLastIdentity: () => {},
  };
  const store: AssetStore = {
    async read() { journalReads++; throw new Error('holding must never open the journal'); },
    async compareAndSwap() { journalWrites++; throw new Error('holding must never mutate the journal'); },
  };
  const provider = { async request({ method, params = [] }: RpcArgs): Promise<unknown> {
    calls.push({ method, params: structuredClone(params) });
    if (method === flags.failMethod) throw new Error('private provider failure');
    if (method === 'eth_chainId') return flags.chain;
    if (method === 'eth_accounts') return flags.accounts;
    if (method === 'eth_getCode') {
      if (params[0] === actor) {
        if (++actorReads === 2) flags.afterLastIdentity();
        return flags.actorCode;
      }
      return flags.code;
    }
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? flags.header : flags.recheck;
    if (method === 'eth_call') {
      const data = (params[0] as { data: string }).data;
      if (data === flags.failData) throw new Error('private contract failure');
      if (flags.interfaces.has(data)) return flags.interfaces.get(data);
      if (data === interfaceCall('0xffffffff')) return word(0n);
      if ([interfaceCall('0x01ffc9a7'), interfaceCall('0x80ac58cd'), interfaceCall('0xd9b67a26')].includes(data)) return word(1n);
      if (data.startsWith('0x6352211e')) { flags.afterHolding(); return flags.owner; }
      if (data.startsWith('0x00fdd58e')) { flags.afterHolding(); return flags.balance; }
    }
    throw new Error(`unexpected read-only call: ${method}`);
  } };
  const guard = () => { if (!flags.connected) throw new Error('CONNECTION_INVALIDATED'); };
  const session = new ExternalAssetSession(provider, chainId, actor, store, guard);
  const assertReadOnly = () => {
    assert.equal(journalReads, 0); assert.equal(journalWrites, 0);
    assert.ok(calls.every(({ method }) => ['eth_chainId', 'eth_accounts', 'eth_getCode', 'eth_getBlockByNumber', 'eth_call'].includes(method)));
  };
  return { flags, calls, session, assertReadOnly };
}

for (const chain of ['1', '8453', '11155111', '84532']) for (const standard of standards)
  test(`${standard} holding on chain ${chain} binds exact identity and pinned block without discovery, metadata or writes`, async () => {
    const f = fixture(chain), result = await f.session.nftHolding(standard, contract, '7');
    assert.deepEqual(result, { chainId: chain, account: actor, contract, tokenId: '7', standard,
      owner: standard === 'ERC-721' ? actor : null, balanceRaw: standard === 'ERC-721' ? '1' : '9007199254740993',
      codeHash: hashControlBytes('0x6000'), blockNumber: '0x64', blockHash });
    assert.ok(Object.isFrozen(result));
    assert.throws(() => { result.balanceRaw = '999'; }, TypeError);
    const data = [interfaceCall('0x01ffc9a7'), interfaceCall('0xffffffff'), interfaceCall(standard === 'ERC-721' ? '0x80ac58cd' : '0xd9b67a26'),
      standard === 'ERC-721' ? ownerCall('7') : balanceCall('7')];
    assert.deepEqual(f.calls.filter(call => call.method === 'eth_call').map(call => call.params),
      data.map(value => [{ to: contract, data: value }, '0x64']));
    assert.deepEqual(f.calls.filter(call => call.method === 'eth_getCode').map(call => call.params),
      [[actor, 'latest'], [contract, '0x64'], [actor, 'latest']]);
    assert.deepEqual(f.calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params),
      [['latest', false], ['0x64', false]]);
    assert.equal(f.calls.filter(call => call.method === 'eth_chainId').length, 2);
    assert.equal(f.calls.filter(call => call.method === 'eth_accounts').length, 2);
    f.assertReadOnly();
  });

test('ERC-721 reports another owner separately from zero account holding without inventing a register claim', async () => {
  const f = fixture(); f.flags.owner = addressWord(other);
  const result = await f.session.nftHolding('ERC-721', contract, '7');
  assert.equal(result.owner, other); assert.equal(result.account, actor); assert.equal(result.balanceRaw, '0');
  for (const claim of ['holder', 'confirmedHolder', 'final', 'metadata', 'artwork', 'tokenURI', 'uri', 'transaction']) assert.equal(Object.hasOwn(result, claim), false);
  f.assertReadOnly();
});

for (const input of [checksum, checksum.toLowerCase(), `0x${checksum.slice(2).toUpperCase()}`])
  test(`NFT explicit contract checksum normalizes only after validation: ${input}`, async () => {
    const f = fixture(), result = await f.session.nftHolding('ERC-721', input, '7');
    assert.equal(result.contract, checksum.toLowerCase()); f.assertReadOnly();
  });

test('ERC-721 owner decoding is byte-oriented rather than a user-input checksum requirement', async () => {
  const f = fixture(); f.flags.owner = addressWord(checksum.slice(0, -1) + 'c');
  assert.equal((await f.session.nftHolding('ERC-721', contract, '7')).owner, `${checksum.slice(0, -1)}c`.toLowerCase());
  f.assertReadOnly();
});

for (const standard of standards) for (const id of ['0', '9007199254740993', maxUint256.toString()])
  test(`${standard} preserves explicit uint256 token ID ${id}`, async () => {
    const f = fixture(), result = await f.session.nftHolding(standard, contract, id);
    assert.equal(result.tokenId, id);
    assert.equal((f.calls.filter(c => c.method === 'eth_call').at(-1)!.params![0] as { data: string }).data,
      standard === 'ERC-721' ? ownerCall(id) : balanceCall(id));
    f.assertReadOnly();
  });
for (const balance of [0n, 1n, 9_007_199_254_740_993n, maxUint256])
  test(`ERC-1155 reports exact integer holding ${balance}, with no decimals assumption`, async () => {
    const f = fixture(); f.flags.balance = word(balance);
    const result = await f.session.nftHolding('ERC-1155', contract, '7');
    assert.equal(result.balanceRaw, balance.toString()); assert.equal(result.owner, null); f.assertReadOnly();
  });

for (const standard of standards) test(`${standard} rejects invalid explicit inputs before any provider call`, async () => {
  const f = fixture();
  for (const input of ['', '0x1234', `0x${'0'.repeat(40)}`, checksum.slice(0, -1) + 'c', `${contract} `, null, 3])
    await assert.rejects(f.session.nftHolding(standard, input as string, '7'), /ASSET_ADDRESS_REFUSED/);
  for (const id of ['', ' ', ' 7', '7 ', '-1', '+1', '01', '1.5', '1e18', '0x1', (1n << 256n).toString(), '9'.repeat(79), null, 1, 1n, {}, NaN])
    await assert.rejects(f.session.nftHolding(standard, contract, id as string), /ASSET_INTEGER_REFUSED/);
  assert.equal(f.calls.length, 0); f.assertReadOnly();
});
for (const standard of ['', 'erc721', 'ERC721', 'erc721-transfer', 'ERC-20', 'ERC-8415', null, 721])
  test(`NFT reader refuses unrecognized standard ${String(standard)} before provider calls`, async () => {
    const f = fixture(); await assert.rejects(f.session.nftHolding(standard as NftStandard, contract, '7'), /ASSET_NFT_STANDARD_REFUSED/);
    assert.equal(f.calls.length, 0); f.assertReadOnly();
  });

for (const code of ['0x', '', '0x0', '0xzz', '6000', null, 0, { result: '0x6000' }]) for (const standard of standards)
  test(`${standard} refuses absent or malformed contract code ${JSON.stringify(code)}`, async () => {
    const f = fixture(); f.flags.code = code;
    await assert.rejects(f.session.nftHolding(standard, contract, '7'), /ASSET_TOKEN_CODE_REQUIRED/);
    assert.equal(f.calls.filter(call => call.method === 'eth_call').length, 0); f.assertReadOnly();
  });

for (const standard of standards) for (const [iid, expected] of [['0x01ffc9a7', 1n], ['0xffffffff', 0n], [standard === 'ERC-721' ? '0x80ac58cd' : '0xd9b67a26', 1n]] as const)
  test(`${standard} rejects unsupported or noncanonical ERC-165 probe ${iid}`, async () => {
    for (const value of [word(1n - expected), word(2n), '0x', '0x01', `${word(expected)}00`, '0xzz', null, true, 1, { result: word(expected) }]) {
      const f = fixture(); f.flags.interfaces.set(interfaceCall(iid), value);
      await assert.rejects(f.session.nftHolding(standard, contract, '7'), /ASSET_NFT_INTERFACE_REFUSED/);
      assert.ok(!f.calls.some(call => call.method === 'eth_call' && [ownerCall('7'), balanceCall('7')].includes((call.params![0] as { data: string }).data)));
      f.assertReadOnly();
    }
  });

for (const raw of ['0x', actor, '0x01', `${addressWord(actor)}00`, addressWord(actor).slice(0, -2),
  `0x1${addressWord(actor).slice(3)}`, word(0n), '0x' + 'g'.repeat(64), null, 0, { result: addressWord(actor) }])
  test(`ERC-721 refuses malformed, noncanonical or zero owner ${JSON.stringify(raw)}`, async () => {
    const f = fixture(); f.flags.owner = raw;
    await assert.rejects(f.session.nftHolding('ERC-721', contract, '7'), /ASSET_NFT_OWNER_REFUSED/); f.assertReadOnly();
  });
for (const raw of ['0x', '0x1', '0x01', `${word(1n)}00`, word(1n).slice(0, -2), '1', '-1', '0x' + 'g'.repeat(64), null, 0, 1n, { result: word(1n) }])
  test(`ERC-1155 refuses malformed balance ${String(raw)}`, async () => {
    const f = fixture(); f.flags.balance = raw;
    await assert.rejects(f.session.nftHolding('ERC-1155', contract, '7'), /ASSET_NFT_BALANCE_REFUSED/); f.assertReadOnly();
  });

for (const standard of standards) for (const change of ['chain', 'account', 'actor-code'] as const)
  test(`${standard} refuses ${change} identity drift after holding reads`, async () => {
    const f = fixture(); f.flags.afterHolding = () => {
      if (change === 'chain') f.flags.chain = '0x2105';
      if (change === 'account') f.flags.accounts = [other];
      if (change === 'actor-code') f.flags.actorCode = '0x6000';
    };
    await assert.rejects(f.session.nftHolding(standard, contract, '7'),
      change === 'chain' ? /ASSET_CHAIN_CHANGED/ : change === 'account' ? /ASSET_ACCOUNT_CHANGED/ : /ASSET_EOA_REQUIRED/);
    f.assertReadOnly();
  });
for (const standard of standards) test(`${standard} rejects initial identity mismatch and unconnected sessions`, async () => {
  for (const changes of [{ chain: '0x2105' }, { chain: '0x01' }, { accounts: [other] }, { accounts: [] }, { accounts: [null] }, { accounts: null }, { actorCode: '0x6000' }, { connected: false }]) {
    const f = fixture(); Object.assign(f.flags, changes);
    await assert.rejects(f.session.nftHolding(standard, contract, '7'));
    assert.equal(f.calls.filter(c => c.method === 'eth_call').length, 0); f.assertReadOnly();
  }
});
for (const standard of standards) test(`${standard} refuses disconnected in-flight reads, including the final identity response`, async () => {
  for (const stage of ['afterHolding', 'afterLastIdentity'] as const) {
    const f = fixture(); f.flags[stage] = () => { f.flags.connected = false; };
    await assert.rejects(f.session.nftHolding(standard, contract, '7'), /CONNECTION_INVALIDATED/); f.assertReadOnly();
  }
});

for (const standard of standards) for (const recheck of [{ number: '0x64', hash: otherHash }, { number: '0x65', hash: blockHash }])
  test(`${standard} refuses reorged or wrongly numbered block recheck ${JSON.stringify(recheck)}`, async () => {
    const f = fixture(); f.flags.recheck = recheck;
    await assert.rejects(f.session.nftHolding(standard, contract, '7'), /ASSET_SNAPSHOT_REORGED/); f.assertReadOnly();
  });
for (const standard of standards) test(`${standard} refuses malformed or missing initial/rechecked block identity`, async () => {
  for (const stage of ['header', 'recheck'] as const) for (const invalid of [null, [], {},
    { number: '0x064', hash: blockHash }, { number: 100, hash: blockHash }, { number: '0x64', hash: word(0n) }, { number: '0x64', hash: '0x1234' }]) {
    const f = fixture(); f.flags[stage] = invalid;
    await assert.rejects(f.session.nftHolding(standard, contract, '7')); f.assertReadOnly();
  }
});
for (const standard of standards) test(`${standard} provider errors and nonexistent tokens remain unavailable rather than zero`, async () => {
  for (const failMethod of ['eth_chainId', 'eth_accounts', 'eth_getCode', 'eth_getBlockByNumber', 'eth_call']) {
    const f = fixture(); f.flags.failMethod = failMethod;
    await assert.rejects(f.session.nftHolding(standard, contract, '7'), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'CONTROL_RPC_REFUSED'); return true;
    }); f.assertReadOnly();
  }
  const f = fixture(); f.flags.failData = standard === 'ERC-721' ? ownerCall('7') : balanceCall('7');
  await assert.rejects(f.session.nftHolding(standard, contract, '7'), /CONTROL_RPC_REFUSED/); f.assertReadOnly();
});

test('holding reads never cache a previous owner or balance across repeated or concurrent reads', async () => {
  const f = fixture();
  assert.equal((await f.session.nftHolding('ERC-721', contract, '7')).balanceRaw, '1');
  f.flags.owner = addressWord(other);
  const holdings = await Promise.all([f.session.nftHolding('ERC-721', contract, '7'), f.session.nftHolding('ERC-1155', contract, '8')]);
  assert.equal(holdings[0]!.owner, other); assert.equal(holdings[0]!.balanceRaw, '0'); assert.equal(holdings[1]!.tokenId, '8');
  f.flags.failData = ownerCall('7');
  await assert.rejects(f.session.nftHolding('ERC-721', contract, '7'), /CONTROL_RPC_REFUSED/); f.assertReadOnly();
});
