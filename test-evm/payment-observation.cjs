const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario}=require('../scripts/controls/scenario-kit.cjs');

describe('Payment lookup independent of retained responsibility legs',function(){
  this.timeout(180000);
  it('observes actual unused, reserved, consumed, detached and paid records without sending from the reader',async()=>{
    const k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
      signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)});
    const sdk=await import('../src/controls/index.ts');
    const pin=async address=>({chainId:k.domain.chainId,controller:address.toLowerCase(),
      runtimeCodeHash:hre.ethers.keccak256(await k.provider.getCode(address))});
    const calls=[];
    const provider={request:async({method,params=[]})=>{
      assert.ok(['eth_chainId','eth_getCode','eth_call','eth_getBlockByNumber'].includes(method),'reader must not request signing or a send');
      calls.push(method);return hre.network.provider.request({method,params});
    }};
    const client=new sdk.NativeResponsibilityPaymentClient(provider,await pin(k.controllerAddress),await pin(k.payments.target));
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true});
    const observe=async state=>{
      const result=await client.observe(s.id,p.c.legId);
      assert.equal(result.payment.state,state);assert.equal(result.readOnly,true);
      assert.equal(result.protocolFinality,'not-evaluated');
      assert.equal((await k.provider.getBlock(Number(result.blockNumber))).hash.toLowerCase(),result.blockHash);
      return result;
    };
    await observe('unfunded');
    await k.transaction('reserve-observation',k.payments.connect(k.signers[1]).reserve(p.c,{value:p.amount}));
    await observe('reserved');assert.equal(await k.controller.legCount(s.id),0n);
    await k.transaction('forward-observation',k.controller.forward(p.c,p.signature));s.legs.push(p.c.legId);
    await observe('funded');
    await k.admit(s,1);await k.complete(s,1);
    await assert.rejects(k.controller.legAt(s.id,0));
    await observe('funded'); // commercial detachment is not a payment transaction
    await k.transaction('allocate-observation',k.payments.allocate(s.id,p.c.legId));
    const due=await observe('settlement-due');assert.equal(due.payment.payee,k.owners[0].toLowerCase());
    await k.transaction('withdraw-observation',k.payments.withdraw(s.id,p.c.legId));
    await observe('settled');assert.ok(calls.length>0);
  });
});
