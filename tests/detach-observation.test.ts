import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { gapTiming, snapshot } = createRequire(import.meta.url)('../scripts/controls/detach-observation.cjs');

test('public-chain gap leaves inclusion headroom without using local clock transactions', () => {
  for (const chain of [11155111n, 560048n]) {
    const t = gapTiming(chain, 1790764176n, 86400n);
    assert.equal(t.deadline, 1790764296n);
    assert.ok(t.deadline > 1790764188n, 'the observed next-block timestamp exceeded the old +3 deadline');
    assert.equal(t.localAutomine, false);
    assert.equal(t.windowSeconds, 120n);
  }
});
test('local automining stays explicit, not inferred from a quiet public chain', () => {
  assert.deepEqual(gapTiming(31337n, 100n, 3n), {deadline:103n, windowSeconds:3n, localAutomine:true});
});
test('unknown/mainnet chains and coercible chain IDs are refused', () => {
  for (const id of [1n, 10n, 0n, 11155111, '11155111', null]) {
    assert.throws(() => gapTiming(id, 100n, 86400n), /DETACH_CHAIN_REFUSED/);
  }
});
test('short or malformed settlement periods do not silently shrink the inclusion window', () => {
  for (const period of [0n, 119n, -1n, 120, '120', undefined]) {
    assert.throws(() => gapTiming(11155111n, 100n, period), /DETACH_SETTLEMENT_PERIOD_REFUSED/);
  }
});
test('timestamp validation and uint64 overflow fail closed', () => {
  for (const time of [-1n, 100, '100', 1n<<64n]) {
    assert.throws(() => gapTiming(11155111n, time, 86400n), /DETACH_TIMESTAMP_REFUSED/);
  }
  assert.throws(() => gapTiming(11155111n, (1n<<64n)-120n, 86400n), /DETACH_DEADLINE_OVERFLOW/);
});

const HASH = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;
const ZERO = `0x${'00'.repeat(32)}`;
function fixture({gap = false, reorg = false, failRead = false, missingBlock = false} = {}) {
  const calls: string[] = [];
  const read = (name: string, value: unknown) => async (...args: unknown[]) => {
    assert.deepEqual(args.at(-1), {blockTag:HASH}, name);
    calls.push(name);
    if (failRead) throw new Error('HISTORICAL_READ_UNAVAILABLE');
    return value;
  };
  const block = {number:123, hash:HASH, timestamp:1000};
  const provider = {getBlock: async (tag: string | number) => {
    if (missingBlock) return null;
    assert.ok(tag === 'latest' || tag === 123);
    return {...block, hash:tag === 123 && reorg ? OTHER : HASH};
  }};
  const projection = {
    currentEntry:read('currentEntry', {version:1n,effectiveAt:900n}),
    openGapOf:read('openGapOf', gap ? OTHER : ZERO),
    settlement:read('settlement', {openedAt:950n}),
    ownerOf:read('ownerOf','D'),holderAsOf:read('holderAsOf','B'),
    isFinalAsOf:read('isFinalAsOf',false),entryCount:read('entryCount',1n),
  };
  const controller = {
    sequence:read('sequence',{appended:2n,completedCount:1n,cursor:2n,currentAccount:'D',revision:4n}),
    detached:read('detached',[1n,OTHER]),
    legAt:read('legAt',{fromAccount:'B',toAccount:'D',outcome:0}),
    activeLegCount:read('activeLegCount',1n),boundaryAccount:read('boundaryAccount','B'),
    inheritedHash:read('inheritedHash',OTHER),
  };
  return {k:{provider,projection,controller,accounts:['A','B','C','D']},calls};
}
test('every snapshot field is read at the same hash, with public block provenance', async () => {
  const {k,calls} = fixture();
  const row = await snapshot(k,{id:OTHER,tokenId:1n},'detached-AB');
  assert.deepEqual(row.observationBlock,{number:123,hash:HASH,timestamp:'1000'});
  assert.equal(row.erc.ownerOf,'D');assert.equal(row.erc.holder,'B');
  assert.equal(row.erc.finalNow,false);
  assert.equal(row.chain.activeLegs,'1');assert.equal(row.chain.detachedCount,'1');
  assert.deepEqual(row.legs[0],{occurrence:'0',detached:true});
  assert.equal(calls.length,13);
});
test('open-gap settlement is pinned too and does not manufacture finality', async () => {
  const {k,calls} = fixture({gap:true});
  const row = await snapshot(k,{id:OTHER,tokenId:1n},'gap-open');
  assert.equal(row.erc.gapOpenedAt,'950');assert.equal(row.erc.finalNow,false);
  assert.ok(calls.includes('settlement'));assert.equal(calls.length,14);
});
test('reorg before final canonicality check refuses the whole row', async () => {
  await assert.rejects(snapshot(fixture({reorg:true}).k,{id:OTHER,tokenId:1n},'reorg'), /DETACH_BLOCK_REORGED/);
});
test('unavailable historical reads never fall back to latest', async () => {
  const {k,calls} = fixture({failRead:true});
  await assert.rejects(snapshot(k,{id:OTHER,tokenId:1n},'unavailable'), /HISTORICAL_READ_UNAVAILABLE/);
  assert.deepEqual(calls,['sequence']);
});
test('missing observation block is refused before contract reads', async () => {
  const {k,calls} = fixture({missingBlock:true});
  await assert.rejects(snapshot(k,{id:OTHER,tokenId:1n},'unavailable'), /DETACH_BLOCK_REFUSED/);
  assert.equal(calls.length,0);
});
