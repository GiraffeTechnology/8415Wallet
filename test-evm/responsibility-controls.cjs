const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario,runCoreJourney,runExtendedJourneys,FORWARD_FIELDS}=require('../scripts/controls/scenario-kit.cjs');
const {observeDetachment}=require('../scripts/controls/detach-observation.cjs');

// Written now, execution intentionally deferred until all V3 implementation is complete.
describe('Independent responsibility controls — real reference projection',function(){
  this.timeout(180000);
  let k,records;
  beforeEach(async()=>{ records=[];k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
    signers:await hre.ethers.getSigners(),artifact:name=>hre.artifacts.readArtifact(name),record:async r=>records.push(r)}); });
  function assertSdkObservations(funded){
    const observations=records.filter(r=>r.kind==='sdk-observation');
    assert.deepEqual(observations.map(r=>r.phase),['forwarded','prefix-detached','tail-returned']);
    assert.deepEqual(observations.map(r=>r.detachedCount),['0','1','1']);
    for(const r of observations){
      assert.equal(r.uiVerified,false);assert.equal(r.readOnly,true);assert.equal(r.protocolFinality,false);
      assert.ok(r.readCalls>0);assert.match(r.textSha256,/^[a-f0-9]{64}$/);
      assert.match(r.viewBlock.hash,/^0x[a-f0-9]{64}$/);assert.match(r.archiveBlock.hash,/^0x[a-f0-9]{64}$/);
    }
    assert.deepEqual(observations[2].payments.map(r=>r.state),funded?['settled','refunded','refunded']:['unfunded','unfunded','unfunded']);
  }
  it('W-04/08/10/12/14/18/19/21: escrow-free prefix detach and actual bounded tail return',async()=>{
    await runCoreJourney(k,{funded:false});assertSdkObservations(false);
  });
  it('W-01/02/04/08/09/10/12/18: independently funded legs release and refund original routes',async()=>{
    await runCoreJourney(k,{funded:true});assertSdkObservations(true);
  });
  it('AB detaches out of a chain that keeps trading, and the window rolls to BC-CD',async()=>{
    const {states}=await observeDetachment(k,{shape:'continuous'});
    assert.equal(states.length,9);
    for(const row of states){
      const block=await k.provider.getBlock(row.observationBlock.number);
      assert.equal(block.hash,row.observationBlock.hash);
      assert.equal(String(block.timestamp),row.observationBlock.timestamp);
      assert.equal(await k.projection.entryCount(1n,{blockTag:block.hash}),BigInt(row.erc.entryCount));
    }
    const at=label=>states.find(r=>r.state===label);
    const abcd=at('forwarded-ABCD'),detached=at('detached-AB'),extended=at('extended-DB-after-detach');
    // The position ran ahead of the register: that lag is the normal state.
    assert.equal(abcd.erc.ownerOf,'D');assert.equal(abcd.erc.holder,'A');
    assert.equal(abcd.chain.activeLegs,'3');assert.equal(abcd.chain.detachedCount,'0');
    // Detachment frees a slot and moves the boundary, and changes nothing on the ERC side.
    assert.equal(detached.chain.activeLegs,'2');assert.equal(detached.chain.detachedCount,'1');
    assert.equal(detached.chain.boundaryAccount,'B');
    assert.equal(detached.erc.ownerOf,abcd.erc.ownerOf);
    assert.equal(detached.erc.entryCount,at('admitted-B').erc.entryCount);
    assert.equal(detached.legs[0].detached,true);
    // Detached history never counts against the window, so the chain keeps extending.
    assert.equal(extended.chain.appended,'4');assert.equal(extended.chain.activeLegs,'3');
    assert.equal(extended.chain.boundaryAccount,'B');
  });
  it('AB alone detaches to an empty window that still extends, without moving the token',async()=>{
    const {states}=await observeDetachment(k,{shape:'ab-only'});
    assert.equal(states.length,5);
    for(const row of states){
      const block=await k.provider.getBlock(row.observationBlock.number);
      assert.equal(block.hash,row.observationBlock.hash);
    }
    const at=label=>states.find(r=>r.state===label);
    const admitted=at('admitted-B'),detached=at('detached-AB'),reopened=at('forwarded-BC-after-empty');
    assert.equal(admitted.erc.ownerOf,'B');assert.equal(admitted.erc.holder,'B');
    assert.equal(detached.chain.activeLegs,'0');assert.equal(detached.chain.completedCount,'1');
    assert.equal(detached.chain.boundaryAccount,'B');
    assert.equal(detached.erc.ownerOf,'B');
    assert.equal(detached.erc.entryCount,admitted.erc.entryCount);
    assert.notEqual(detached.chain.detachedCommitment,`0x${'0'.repeat(64)}`);
    // An empty window is not a closed one: occurrence 1 opens on the same sequence.
    assert.equal(reopened.chain.appended,'2');assert.equal(reopened.chain.activeLegs,'1');
    assert.equal(reopened.chain.detachedCount,'1');assert.equal(reopened.chain.boundaryAccount,'B');
  });
  it('shared journey observer refuses corrupted receipt archives without recording success or sending',async()=>{
    const {observeJourney}=require('../scripts/controls/observe-journey.cjs');
    const s=await k.open();for(let i=0;i<3;i++)await k.forward(s,i,i+1);
    await k.admit(s,1);await k.complete(s,1);
    const original=s.detachedRecords[0].termsHash;s.detachedRecords[0].termsHash=hre.ethers.id('tampered');
    const calls=[],before=records.length;
    const readOnly={...k,provider:{send:async(method,params)=>{
      calls.push(method);assert.ok(['eth_chainId','eth_getCode','eth_call','eth_getBlockByNumber'].includes(method));
      return k.provider.send(method,params);
    }}};
    await assert.rejects(observeJourney(readOnly,s,'prefix-detached',{funded:false}),/CONTROL_ARCHIVE_COMMITMENT_REFUSED/);
    assert.equal(records.length,before);assert.ok(calls.length>0);
    s.detachedRecords[0].termsHash=original;
    const result=await observeJourney(readOnly,s,'prefix-detached',{funded:false});
    assert.equal(result.detachedCount,'1');assert.equal(records.length,before+1);
  });
  it('shared journey observer keeps the deployment-time runtime pin and refuses code substitution',async()=>{
    const {observeJourney}=require('../scripts/controls/observe-journey.cjs');
    const s=await k.open();for(let i=0;i<3;i++)await k.forward(s,i,i+1);
    const before=records.length;
    const changed={...k,provider:{send:async(method,params)=>method==='eth_getCode'?'0x6001':k.provider.send(method,params)}};
    await assert.rejects(observeJourney(changed,s,'forwarded',{funded:false}),/CONTROL_RUNTIME_PIN_MISMATCH/);
    assert.equal(records.length,before);
  });
  // These journeys were reachable only from the public-testnet runner, which
  // has not been run. Locally they were dead coverage, so the W-03 observation
  // that ordinary register lag never locks a forward — and the tail-extension,
  // repeated-occurrence and callback-race journeys beside it — went unexercised
  // on every run this repository has actually made.
  it('W-03/05/06/12/15/17: open-gap lag, tail extension, repeated occurrences and callback races',async()=>{
    await runExtendedJourneys(k);
  });
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
