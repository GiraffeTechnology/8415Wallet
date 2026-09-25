import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id, keccak256 } from 'ethers';
import { encodeCall } from '../src/codec/abi.ts';
import { DetachedResponsibilityHistoryClient } from '../src/controls/detachedHistory.ts';
import type { Eip1193Provider } from '../src/adapters/signing/eip1193Signer.ts';
const a=(n:string)=>`0x${n.repeat(40)}`, h=(n:string)=>`0x${n.repeat(64)}`;
const abi=AbiCoder.defaultAbiCoder(), code='0x60006000';
const pin={chainId:560048n,controller:a('1'),runtimeCodeHash:keccak256(code)}, sequenceId=h('1');
const sequenceTypes=['address','uint256','address','address','address','bytes32','bytes32','bytes32',
  'uint256','uint256','uint256','uint256','uint256','bytes32','bool'];
function fixture(count=3, fault='', mutate?:()=>void) {
  let commitment=keccak256(abi.encode(['bytes32','bytes32'],[id('8415Wallet/DetachedResponsibilities/v1'),sequenceId]));
  const records=Array.from({length:count},(_,i)=>{
    const r={occurrence:String(i),legId:keccak256(abi.encode(['uint256'],[i+1])),
      fromAccount:a(i%2===0?'3':'4'),toAccount:a(i%2===0?'4':'3'),termsHash:h('2'),acceptanceHash:h('3'),
      returnAuthority:a('5'),returnConditionHash:h('4'),detachedCommitment:''};
    commitment=keccak256(abi.encode(['bytes32','uint256','bytes32','address','address','bytes32','bytes32','address','bytes32'],
      [commitment,i,r.legId,r.fromAccount,r.toAccount,r.termsHash,r.acceptanceHash,r.returnAuthority,r.returnConditionHash]));
    r.detachedCommitment=commitment;return r;
  });
  const anchor=count===0?h('0'):commitment;
  const document={schema:'8415-detached-history/1',chainId:'560048',controller:pin.controller,sequenceId,records};
  const calls:string[]=[]; let chains=0;
  const provider:Eip1193Provider={async request({method,params=[]}){
    calls.push(method);
    if(method==='eth_chainId'){
      if(++chains===1)mutate?.();
      return fault==='chain-switch'&&chains===2?'0x1':'0x88bb0';
    }
    if(method==='eth_getCode')return fault==='code-drift'&&chains===2?'0x6001':code;
    if(method==='eth_getBlockByNumber'){
      if(fault==='late-missing'&&chains===2)return null;
      if(fault==='late-transport'&&chains===2)throw Error('not public');
      return {number:'0x2',timestamp:'0x3',hash:fault==='late-reorg'&&chains===2?h('b'):h('a')};
    }
    if(method==='eth_call'){
      assert.deepEqual(params[1],{blockHash:h('a'),requireCanonical:true});
      const data=(params[0] as {data:string}).data;
      if(data===encodeCall('sequence(bytes32)',['bytes32'],[sequenceId]))return abi.encode(sequenceTypes,
        [a('6'),1,a('3'),fault==='boundary'?a('7'):a(count%2===0?'3':'4'),a('5'),h('5'),h('6'),h('7'),
          count,count,count,0,count,fault==='commitment'?h('9'):anchor,false]);
      if(data===encodeCall('legCount(bytes32)',['bytes32'],[sequenceId]))return abi.encode(['uint256'],[count]);
      if(data===encodeCall('inheritedHash(bytes32)',['bytes32'],[sequenceId]))return abi.encode(['bytes32'],[h('8')]);
    }
    throw Error('UNEXPECTED_RPC');
  }};
  return {document,calls,client:new DetachedResponsibilityHistoryClient(provider,pin)};
}
for(const count of [0,1,3,130])test(`verifies ${count} detached records including repeated accounts without a lifetime-window limit`,async()=>{
  const {document,client,calls}=fixture(count);const r=await client.observe(sequenceId,document);
  assert.equal(r.detachedCount,BigInt(count));assert.equal(r.records.length,count);
  assert.equal(r.readOnly,true);assert.equal(r.protocolFinality,'not-evaluated');
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.records)&&r.records.every(Object.isFrozen));
  assert.equal(calls.at(-1),'eth_getBlockByNumber');
  assert.ok(calls.every(x=>['eth_chainId','eth_call','eth_getCode','eth_getBlockByNumber'].includes(x)));
});
for(const field of ['legId','termsHash','acceptanceHash','returnConditionHash','detachedCommitment'] as const)
  test(`refuses changed archived ${field}`,async()=>{
    const f=fixture();f.document.records[1]![field]=h('f');
    await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_COMMITMENT_REFUSED/);
  });
for(const field of ['fromAccount','toAccount','returnAuthority'] as const)test(`refuses substituted ${field}`,async()=>{
  const f=fixture();f.document.records[1]![field]=a('f');
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_(ORDER|COMMITMENT)_REFUSED/);
});
for(const change of ['missing','extra','reorder','duplicate','suffix'] as const)test(`refuses ${change} record sequence`,async()=>{
  const f=fixture(),r=f.document.records;
  if(change==='missing')r.pop();else if(change==='extra')r.push({...r[0]!});
  else if(change==='reorder')r.reverse();else if(change==='duplicate')r[1]={...r[0]!};else r.shift();
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_(COUNT|ORDER)_REFUSED/);
});
for(const field of ['schema','chainId','controller','sequenceId'] as const)test(`refuses wrong ${field} before RPC`,async()=>{
  const f=fixture();f.document[field]=field==='chainId'?'1':field==='controller'?a('9'):field==='sequenceId'?h('9'):'unknown';
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_BINDING_REFUSED/);assert.equal(f.calls.length,0);
});
test('strict document schema rejects extra success/secret fields and lossy occurrences',async()=>{
  const f=fixture();
  for(const document of [{...f.document,verified:true},{...f.document,signature:'not accepted'},
    {...f.document,records:[{...f.document.records[0],complete:true}]}])
    await assert.rejects(f.client.observe(sequenceId,document),/CONTROL_ARCHIVE_SCHEMA_REFUSED/);
  for(const occurrence of ['01','-1',String(1n<<256n),1]) {
    await assert.rejects(f.client.observe(sequenceId,{...f.document,records:[{...f.document.records[0],occurrence}]}),/CONTROL_ARCHIVE_INTEGER_REFUSED/);
  }
  assert.equal(f.calls.length,0);
});
for(const [fault,expected]of [['commitment','CONTROL_ARCHIVE_COMMITMENT_REFUSED'],['boundary','CONTROL_ARCHIVE_BOUNDARY_REFUSED'],
  ['late-reorg','CONTROL_SNAPSHOT_REORGED'],['late-missing','CONTROL_RPC_SCHEMA_REFUSED'],['late-transport','CONTROL_RPC_REFUSED'],
  ['chain-switch','CONTROL_CHAIN_MISMATCH'],['code-drift','CONTROL_RUNTIME_PIN_MISMATCH']] as const)
  test(`refuses ${fault} without a verified result`,async()=>{
    const f=fixture(3,fault);await assert.rejects(f.client.observe(sequenceId,f.document),new RegExp(expected));
  });
test('copies public input before the first asynchronous RPC',async()=>{
  const f=fixture(3,'',()=>{f.document.records[0]!.termsHash=h('f');f.document.records.reverse();});
  const r=await f.client.observe(sequenceId,f.document);assert.equal(r.records[0]!.termsHash,h('2'));assert.equal(r.records[0]!.occurrence,0n);
});

test('does not dispatch an input-owned array mapper',async()=>{
  const f=fixture();let called=false;
  Object.defineProperty(f.document.records,'map',{value:()=>{called=true;throw Error('UNTRUSTED_MAP');}});
  const result=await f.client.observe(sequenceId,f.document);
  assert.equal(called,false);assert.equal(result.records.length,3);
  assert.ok(result.records.every(Object.isFrozen));
  assert.notEqual(result.records[0],f.document.records[0]);
});

test('cannot bypass exact record validation through an input mapper',async()=>{
  const f=fixture();
  const forged=f.document.records.map(r=>({...r,occurrence:BigInt(r.occurrence),verified:true}));
  Object.assign(f.document.records[0]!,{verified:true});
  Object.defineProperty(f.document.records,'map',{value:()=>forged});
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_SCHEMA_REFUSED/);
  assert.equal(f.calls.length,0);
});

test('never reads an input array map getter',async()=>{
  const f=fixture();
  Object.defineProperty(f.document.records,'map',{get(){throw Error('UNTRUSTED_MAP_GETTER');}});
  const result=await f.client.observe(sequenceId,f.document);
  assert.equal(result.records.length,3);
});

test('does not construct copies through input Array species',async()=>{
  const f=fixture();
  class PublicRecords extends Array<typeof f.document.records[number]> {
    static override get [Symbol.species](): ArrayConstructor { throw Error('UNTRUSTED_SPECIES'); }
  }
  const records=new PublicRecords();records.push(...f.document.records);
  const result=await f.client.observe(sequenceId,{...f.document,records});
  assert.equal(Object.getPrototypeOf(result.records),Array.prototype);
  assert.ok(result.records.every(Object.isFrozen));
});

test('refuses sparse records with a stable schema error before RPC',async()=>{
  const f=fixture();delete f.document.records[1];
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_SCHEMA_REFUSED/);
  assert.equal(f.calls.length,0);
});

test('refuses records supplied only by an array prototype',async()=>{
  const f=fixture(),record=f.document.records[1];delete f.document.records[1];
  const inherited=Object.create(Array.prototype);inherited[1]=record;
  Object.setPrototypeOf(f.document.records,inherited);
  await assert.rejects(f.client.observe(sequenceId,f.document),/CONTROL_ARCHIVE_SCHEMA_REFUSED/);
  assert.equal(f.calls.length,0);
});
