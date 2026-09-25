const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario,runCoreJourney,FORWARD_FIELDS}=require('../scripts/controls/scenario-kit.cjs');

// Written now, execution intentionally deferred until all V3 implementation is complete.
describe('Independent responsibility controls — real reference projection',function(){
  this.timeout(180000);
  let k;
  beforeEach(async()=>{ k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
    signers:await hre.ethers.getSigners(),artifact:name=>hre.artifacts.readArtifact(name)}); });
  it('W-04/08/10/12/14/18/19/21: escrow-free prefix detach and actual bounded tail return',async()=>{await runCoreJourney(k,{funded:false});});
  it('W-01/02/04/08/09/10/12/18: independently funded legs release and refund original routes',async()=>{await runCoreJourney(k,{funded:true});});
  it('W-07: unresolved root propagates through every descendant and actually returns to A',async()=>{
    const s=await k.open(); for(let i=0;i<3;i++)await k.forward(s,i,i+1,{funded:true});
    await k.beginReturn(s,1);
    for(let i=2;i>=0;i--){await k.hop(s);await k.payout(s,i,i+1,5n);}
    assert.equal(await k.projection.ownerOf(s.tokenId),k.accounts[0]);
    assert.equal((await k.state(s)).completedCount,0n);
  });
  it('W-05/06: holder already at C completes AB and BC without rewinding or losing a tail',async()=>{
    const s=await k.open();await k.forward(s,0,1);await k.forward(s,1,2);await k.admit(s,2);
    const pending=await k.consent(s,2,3);await k.complete(s,1);
    await k.refused('stale-tail-after-completion',()=>k.controller.connect(k.signers[2]).forward.staticCall(pending.c,pending.signature),k.controller,'RevisionMismatch');
    await k.forward(s,2,3);await k.complete(s,2);
    assert.equal(await k.controller.legCount(s.id),3n);assert.equal((await k.controller.legAt(s.id,2)).outcome,0n);
  });
  it('W-13/15: exact recipient consent and repeated addresses retain separate occurrences',async()=>{
    const s=await k.open();await k.forward(s,0,1);await k.forward(s,1,0);await k.forward(s,0,2);
    await k.admit(s,2);await k.complete(s,2);
    assert.equal((await k.state(s)).completedCount,2n);
    await k.refused('cannot-rebind-one-entry',async()=>k.controller.connect(k.signers[4]).bindAdmission.staticCall(s.id,0,2,(await k.state(s)).revision),k.controller,'AdmissionBindingImmutable');
  });
  it('W-17: accepted callback wins serialization and refuses stale or fresh completion',async()=>{
    const s=await k.open();await k.forward(s,0,1);await k.admit(s,1);const revision=(await k.state(s)).revision;
    await k.beginReturn(s,1);
    await k.refused('stale-completion',()=>k.controller.completeThrough.staticCall(s.id,s.legs[0],revision),k.controller,'RevisionMismatch');
    await k.refused('callback-precludes-completion',async()=>k.controller.completeThrough.staticCall(s.id,s.legs[0],(await k.state(s)).revision),k.controller,'CallbackActive');
  });
  it('nonce invalidation and foreign recipient signatures cannot forward',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1);
    await k.refused('malformed-signature',()=>k.controller.forward.staticCall(p.c,'0x1234'),k.controller,'ConsentRefused');
    await k.transaction('invalidate-consent',k.controller.connect(k.signers[1]).invalidateRecipientNonce(1));
    await k.refused('invalidated-signature',()=>k.controller.forward.staticCall(p.c,p.signature),k.controller,'ConsentRefused');
    assert.equal(await k.projection.ownerOf(s.tokenId),k.accounts[0]);
  });
  it('W-13: unsupported recipients, wrong domain, expired terms and forged acceptance refuse',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1);
    const check=(label,c,sig,code)=>k.refused(label,()=>k.controller.forward.staticCall(c,sig),k.controller,code);
    await check('plain-eoa-recipient',{...p.c,toAccount:k.owners[1]},p.signature,'RecipientUnsupported');
    await check('self-recipient',{...p.c,toAccount:k.accounts[0]},p.signature,'RecipientUnsupported');
    await check('expired-consent',{...p.c,deadline:1n},p.signature,'ConsentRefused');
    const foreign=await k.signers[1].signTypedData({...k.domain,chainId:k.domain.chainId+1n},{ForwardConsent:FORWARD_FIELDS},p.c);
    await check('wrong-chain-signature',p.c,foreign,'ConsentRefused');
    const wrongSigner=await k.signers[2].signTypedData(k.domain,{ForwardConsent:FORWARD_FIELDS},p.c);
    await check('wrong-recipient-signature',p.c,wrongSigner,'ConsentRefused');
    await check('substituted-terms',{...p.c,termsHash:k.hash('unaccepted terms')},p.signature,'ConsentRefused');
    await check('substituted-inheritance',{...p.c,inheritedHash:k.hash('unaccepted upstream')},p.signature,'InheritanceMismatch');
    assert.equal((await k.state(s)).revision,0n);assert.equal(await k.controller.legCount(s.id),0n);
    assert.equal(await k.controller.recipientNonces(k.owners[1]),0n);
  });
  it('no unaccepted caller or condition can turn registration lag into a return',async()=>{
    const s=await k.open();await k.forward(s,0,1);const revision=(await k.state(s)).revision;
    await k.refused('unauthorized-condition-caller',()=>k.controller.beginReturn.staticCall(s.id,s.legs[0],k.conditionHash,k.uid('evidence'),revision),k.controller,'Unauthorized');
    await k.refused('unaccepted-condition',()=>k.controller.connect(k.signers[4]).beginReturn.staticCall(s.id,s.legs[0],k.hash('lag invented remedy'),k.uid('evidence'),revision),k.controller,'InvalidInput');
    await k.refused('empty-condition-evidence',()=>k.controller.connect(k.signers[4]).beginReturn.staticCall(s.id,s.legs[0],k.conditionHash,hre.ethers.ZeroHash,revision),k.controller,'InvalidInput');
    assert.equal((await k.state(s)).callbackRootPlusOne,0n);
    assert.equal((await k.controller.legAt(s.id,0)).outcome,0n);
  });
});
