import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCall, encodeWords } from '../src/codec/abi.ts';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { NativeResponsibilityPaymentClient } from '../src/controls/payments.ts';
import type { Eip1193Provider } from '../src/adapters/signing/eip1193Signer.ts';
const a=(n:string)=>`0x${n.repeat(40)}`, h=(n:string)=>`0x${n.repeat(64)}`;
const code='0x60006000';
const controller={chainId:560048n,controller:a('1'),runtimeCodeHash:hashControlBytes(code)};
const adapter={...controller,controller:a('2')};
function fixture(state=6n, fault='') {
  const calls:{method:string;params:readonly unknown[]}[]=[];
  let finalHeader=false;
  const provider:Eip1193Provider={async request({method,params=[]}) {
    calls.push({method,params});
    if(method==='eth_chainId')return fault==='chain-switch'&&finalHeader?'0x1':`0x${controller.chainId.toString(16)}`;
    if(method==='eth_getCode')return fault==='historical-code'&&typeof params[1]==='object'?'0x6001':code;
    if(method==='eth_getBlockByNumber') {
      if(params[0]!=='latest')finalHeader=true;
      if(fault==='missing-block')return null;
      return {hash:fault==='reorg'&&finalHeader?h('b'):h('a'),number:fault==='bad-number'?'0x00':'0x2',timestamp:'0x3'};
    }
    if(method==='eth_call') {
      const tx=params[0] as {to:string;data:string};
      if(tx.data===encodeCall('controller()',[],[]))return encodeWords(['address'],[controller.controller]);
      if(tx.data===encodeCall('nativePayments()',[],[]))return encodeWords(['address'],[adapter.controller]);
      if(tx.data===encodeCall('payment(bytes32,bytes32)',['bytes32','bytes32'],[h('1'),h('2')])) {
        assert.deepEqual(params[1],{blockHash:h('a'),requireCanonical:true});
        if(fault==='transport')throw Error('private provider text must not escape');
        if(fault==='malformed')return '0x01';
        return encodeWords(['address','address','uint256','uint8'],[a('3'),a('4'),1000n,state]);
      }
    }
    throw Error('UNEXPECTED_RPC_METHOD');
  }};
  return {client:new NativeResponsibilityPaymentClient(provider,controller,adapter),calls};
}
const names=['unfunded','funded','settlement-due','refund-due','settled','refunded','reserved'];
for(const [i,state]of names.entries())test(`payment observation reads ${state} without a live leg or execution`,async()=>{
  const {client,calls}=fixture(BigInt(i));const result=await client.observe(h('1'),h('2'));
  assert.deepEqual(result,{blockNumber:2n,blockHash:h('a'),timestamp:3n,readOnly:true,protocolFinality:'not-evaluated',
    payment:{sequenceId:h('1'),legId:h('2'),payer:a('3'),payee:a('4'),amount:1000n,state}});
  assert.ok(calls.every(c=>['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_call'].includes(c.method)));
  assert.equal(calls.filter(c=>c.method==='eth_call').some(c=>
    ((c.params[0]as{data:string}).data.startsWith(encodeCall('legAt(bytes32,uint256)',['bytes32','uint256'],[h('1'),0n]).slice(0,10)))),false);
});
for(const [fault,expected]of [['reorg','CONTROL_SNAPSHOT_REORGED'],['chain-switch','CONTROL_CHAIN_MISMATCH'],
  ['historical-code','CONTROL_RUNTIME_PIN_MISMATCH'],['missing-block','CONTROL_RPC_SCHEMA_REFUSED'],
  ['bad-number','CONTROL_RPC_QUANTITY_REFUSED'],['malformed','CONTROL_ABI_LENGTH_REFUSED'],
  ['transport','CONTROL_RPC_REFUSED']] as const)test(`payment observation refuses ${fault} without partial success`,async()=>{
  const {client}=fixture(6n,fault);await assert.rejects(client.observe(h('1'),h('2')),new RegExp(expected));
});
test('payment observation rejects malformed IDs before RPC and unknown states without success',async()=>{
  const {client,calls}=fixture(7n);
  await assert.rejects(client.observe('not-an-id',h('2')),/CONTROL_PAYMENT_ID_REFUSED/);assert.equal(calls.length,0);
  await assert.rejects(client.observe(h('1'),h('2')),/CONTROL_PAYMENT_STATE_REFUSED/);
});
