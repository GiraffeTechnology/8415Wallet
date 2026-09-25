const assert=require('node:assert/strict');
const crypto=require('node:crypto');

// Shared by the local real-EVM suite and the public-testnet runner. This is
// SDK/text-render evidence, never a browser journey or permission to transact.
async function observeJourney(k,s,phase,{funded}) {
  assert.ok(['forwarded','prefix-detached','tail-returned'].includes(phase),'SCENARIO_OBSERVATION_PHASE_REFUSED');
  const {RpcResponsibilityControlReader,DetachedResponsibilityHistoryClient,
    NativeResponsibilityPaymentClient}=await import('../../src/controls/index.ts');
  const {buildLinkedChainView}=await import('../../src/wallet/linkedChainView.ts');
  const {renderLinkedChain}=await import('../../src/wallet/renderLinkedChain.ts');
  const calls=[];
  const reader={request:async({method,params=[]})=>{
    assert.ok(['eth_chainId','eth_getCode','eth_call','eth_getBlockByNumber'].includes(method),'SCENARIO_READER_WRITE_REFUSED');
    calls.push(method);return k.provider.send(method,params);
  }};
  const pin=k.observationPins.controller;
  const observed=await new RpcResponsibilityControlReader(reader,pin).observe(s.id);
  const view=buildLinkedChainView(observed.snapshot,observed.evidence);
  const text=renderLinkedChain({...view,protocolFinality:observed.projection.protocolFinality});
  const archive=await new DetachedResponsibilityHistoryClient(reader,pin).observe(s.id,{
    schema:'8415-detached-history/1',chainId:String(pin.chainId),controller:pin.controller,
    sequenceId:s.id,records:s.detachedRecords,
  });
  const detached=phase==='forwarded'?0n:1n;
  assert.equal(observed.snapshot.offChainDetached,detached,'SCENARIO_VIEW_DETACHED_COUNT');
  assert.equal(archive.detachedCount,detached,'SCENARIO_ARCHIVE_DETACHED_COUNT');
  assert.equal(observed.projection.owner,k.accounts[phase==='tail-returned'?1:3].toLowerCase(),'SCENARIO_VIEW_OWNER');
  assert.equal(observed.projection.holder,k.accounts[phase==='forwarded'?0:1].toLowerCase(),'SCENARIO_VIEW_HOLDER');
  assert.equal(observed.projection.protocolFinality,false,'SCENARIO_FINALITY_CONFLATED');
  assert.equal(view.legs.length,phase==='forwarded'?3:2,'SCENARIO_VIEW_LIVE_LEGS');
  assert.equal(view.returnBoundary.account,k.accounts[phase==='forwarded'?0:1].toLowerCase(),'SCENARIO_VIEW_RETURN_BOUNDARY');
  assert.ok(text.includes('ERC temporal finality: provisional'),'SCENARIO_FINALITY_RENDER');
  if(detached>0n)assert.ok(text.includes('Detached and held off chain: 1'),'SCENARIO_DETACHED_RENDER');
  const paymentClient=new NativeResponsibilityPaymentClient(reader,pin,k.observationPins.payment);
  const paymentObservations=[];
  for(let i=0;i<s.legs.length;i++){
    const p=await paymentClient.observe(s.id,s.legs[i]);
    const expected=!funded?'unfunded':phase==='forwarded'?'funded':i===0?'settled':phase==='tail-returned'?'refunded':'funded';
    assert.equal(p.payment.state,expected,'SCENARIO_PAYMENT_OBSERVATION');
    paymentObservations.push({legId:s.legs[i],state:p.payment.state,blockNumber:String(p.blockNumber),blockHash:p.blockHash});
  }
  // Readers take separate canonical snapshots: retain each block identity rather
  // than falsely claiming the entire multi-read observation is one atomic read.
  const result={kind:'sdk-observation',phase,sequenceId:s.id,tokenId:String(s.tokenId),chainId:String(pin.chainId),
    viewBlock:{number:String(view.blockNumber),hash:view.blockHash},
    archiveBlock:{number:String(archive.blockNumber),hash:archive.blockHash},
    detachedCount:String(archive.detachedCount),detachedCommitment:archive.detachedCommitment,
    owner:observed.projection.owner,holder:observed.projection.holder,protocolFinality:observed.projection.protocolFinality,
    liveLegs:view.legs.length,returnBoundary:view.returnBoundary.account,payments:paymentObservations,
    textSha256:crypto.createHash('sha256').update(text,'utf8').digest('hex'),
    readCalls:calls.length,readOnly:true,uiVerified:false,independentAuditPassed:false};
  await k.record(result);return result;
}
module.exports={observeJourney};
