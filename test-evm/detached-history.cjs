const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario}=require('../scripts/controls/scenario-kit.cjs');

describe('W-23/24: public detached history checked against real control commitments',function(){
  this.timeout(180000);
  it('verifies emitted records across pruning, repeated wallets and a live tail, with no reader writes',async()=>{
    const k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
      signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)});
    const {DetachedResponsibilityHistoryClient}=await import('../src/controls/index.ts');
    const pin={chainId:k.domain.chainId,controller:k.controllerAddress.toLowerCase(),
      runtimeCodeHash:hre.ethers.keccak256(await k.provider.getCode(k.controllerAddress))};
    const calls=[];
    const reader={request:async({method,params=[]})=>{
      assert.ok(['eth_chainId','eth_getCode','eth_call','eth_getBlockByNumber'].includes(method));
      calls.push(method);return hre.network.provider.request({method,params});
    }};
    const client=new DetachedResponsibilityHistoryClient(reader,pin),s=await k.open();
    const document=async()=>({schema:'8415-detached-history/1',chainId:String(pin.chainId),controller:pin.controller,sequenceId:s.id,
      records:(await k.controller.queryFilter(k.controller.filters.LegDetached(s.id))).map(({args:r})=>({
        occurrence:String(r.occurrence),legId:r.legId,fromAccount:r.fromAccount,toAccount:r.toAccount,
        termsHash:r.termsHash,acceptanceHash:r.acceptanceHash,returnAuthority:r.returnAuthority,
        returnConditionHash:r.returnConditionHash,detachedCommitment:r.detachedCommitment}))});
    assert.equal((await client.observe(s.id,await document())).detachedCount,0n);
    await k.forward(s,0,1);await k.forward(s,1,0);await k.forward(s,0,2);
    await k.admit(s,2);await k.complete(s,1);
    const prefix=await document(),one=await client.observe(s.id,prefix);
    assert.equal(one.detachedCount,1n);assert.equal(one.records[0].toAccount,k.accounts[1].toLowerCase());
    await assert.rejects(k.controller.legAt(s.id,0));assert.equal((await k.controller.legAt(s.id,1)).fromAccount,k.accounts[1]);
    await k.complete(s,2);
    await assert.rejects(client.observe(s.id,prefix),/CONTROL_ARCHIVE_COUNT_REFUSED/);
    const two=await client.observe(s.id,await document());assert.equal(two.records[1].toAccount,k.accounts[0].toLowerCase());
    await k.admit(s,3);await k.complete(s,3);
    const full=await document(),complete=await client.observe(s.id,full);
    assert.equal(complete.detachedCount,3n);assert.equal(complete.detachedCommitment,(await k.state(s)).detachedCommitment);
    assert.equal(complete.protocolFinality,'not-evaluated');assert.equal(complete.readOnly,true);
    assert.equal(calls.at(-1),'eth_getBlockByNumber');
    const forged=structuredClone(full);forged.records[1].termsHash=hre.ethers.id('substituted public terms');
    // Rehashing the entire attacker-provided archive still cannot replace the chain anchor.
    let digest=hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32'],
      [hre.ethers.id('8415Wallet/DetachedResponsibilities/v1'),s.id]));
    for(const r of forged.records){
      digest=hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32','uint256','bytes32','address','address','bytes32','bytes32','address','bytes32'],
        [digest,r.occurrence,r.legId,r.fromAccount,r.toAccount,r.termsHash,r.acceptanceHash,r.returnAuthority,r.returnConditionHash]));
      r.detachedCommitment=digest;
    }
    await assert.rejects(client.observe(s.id,forged),/CONTROL_ARCHIVE_COMMITMENT_REFUSED/);
    await assert.rejects(client.observe(s.id,{...full,sequenceId:k.uid('foreign')}),/CONTROL_ARCHIVE_BINDING_REFUSED/);
  });
});
