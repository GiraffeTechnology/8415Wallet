const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario,FORWARD_FIELDS}=require('../scripts/controls/scenario-kit.cjs');

describe('Exact pre-forward payment reservations and current evidence authority',function(){
  this.timeout(180000);
  let k;
  beforeEach(async()=>{k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
    signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)});});
  const sign=async c=>k.signers[1].signTypedData(k.domain,{ForwardConsent:FORWARD_FIELDS},c);
  const reserve=p=>k.transaction('reserve',k.payments.connect(k.signers[1]).reserve(p.c,{value:p.amount}));
  it('refuses unpaid forward, then reserves atomically; completed buyer cannot escape seller settlement',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true});
    await k.refused('no-reservation',()=>k.controller.forward.staticCall(p.c,p.signature),k.payments,'InvalidPayment');
    assert.equal(await k.projection.ownerOf(s.tokenId),k.accounts[0]);assert.equal((await k.state(s)).revision,0n);
    await reserve(p);assert.equal((await k.payments.payment(s.id,p.c.legId)).state,6n);
    await k.refused('live-reservation-cancel',()=>k.payments.connect(k.signers[1]).cancelReservation.staticCall(s.id,p.c.legId),k.payments,'OutcomeUnavailable');
    await k.transaction('funded-forward',k.controller.forward(p.c,p.signature));s.legs.push(p.c.legId);
    assert.equal((await k.payments.payment(s.id,p.c.legId)).state,1n);
    await k.admit(s,1);await k.complete(s,1);
    await k.transaction('close',k.controller.connect(k.signers[1]).closeSequence(s.id,(await k.state(s)).revision));
    await k.transaction('buyer-exit',k.account(1).withdrawStandalone(k.projectionAddress,s.tokenId,k.owners[1]));
    assert.equal(await k.provider.getBalance(k.payments.target),p.amount);
    await k.payout(s,0,0,4n);assert.equal(await k.provider.getBalance(k.payments.target),0n);
    await k.refused('double-payout',()=>k.payments.withdraw.staticCall(s.id,p.c.legId),k.payments,'InvalidPayment');
  });
  it('rejects wrong payer/amount/terms/adapter, duplicate reservation and direct consumption',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true});
    await k.refused('wrong-payer',()=>k.payments.reserve.staticCall(p.c,{value:p.amount}),k.payments,'Unauthorized');
    await k.refused('wrong-amount',()=>k.payments.connect(k.signers[1]).reserve.staticCall(p.c,{value:p.amount-1n}),k.payments,'InvalidPayment');
    await k.refused('wrong-terms',()=>k.payments.connect(k.signers[1]).reserve.staticCall({...p.c,termsHash:k.hash('other')},{value:p.amount}),k.payments,'InvalidPayment');
    await reserve(p);
    await k.refused('duplicate',()=>k.payments.connect(k.signers[1]).reserve.staticCall(p.c,{value:p.amount}),k.payments,'InvalidPayment');
    await k.refused('direct-consumption',()=>k.payments.consumeReservation.staticCall(p.c),k.payments,'Unauthorized');
    const changed={...p.c,returnConditionHash:k.hash('other accepted condition')};
    await k.refused('different-digest',()=>k.controller.forward.staticCall(changed,sign(changed)),k.payments,'InvalidPayment');
    const foreign={...p.c,paymentAdapter:k.owners[2]};
    await k.refused('foreign-adapter',()=>k.controller.forward.staticCall(foreign,sign(foreign)),k.controller,'InvalidInput');
    await k.refused('signature-bound-profile',()=>k.controller.forward.staticCall({...p.c,paymentAdapter:hre.ethers.ZeroAddress,paymentAmount:0},p.signature),k.controller,'ConsentRefused');
    await k.refused('factory-once',()=>k.controller.createNativePayments.staticCall(),k.controller,'InvalidInput');
  });
  it('nonce invalidation releases only original unused reservation; old signed forward cannot revive it',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true});await reserve(p);
    await k.transaction('invalidate',k.controller.connect(k.signers[1]).invalidateRecipientNonce(p.c.recipientNonce+1n));
    await k.refused('stranger-cancel',()=>k.payments.cancelReservation.staticCall(s.id,p.c.legId),k.payments,'Unauthorized');
    await k.transaction('cancel',k.payments.connect(k.signers[1]).cancelReservation(s.id,p.c.legId));
    await k.refused('wrong-refund-recipient',()=>k.payments.withdraw.staticCall(s.id,p.c.legId),k.payments,'Unauthorized');
    await k.transaction('refund',k.payments.connect(k.signers[1]).withdraw(s.id,p.c.legId));
    await k.refused('stale-forward',()=>k.controller.forward.staticCall(p.c,p.signature),k.controller,'ConsentRefused');
    assert.equal((await k.payments.payment(s.id,p.c.legId)).state,5n);
    assert.equal(await k.projection.ownerOf(s.tokenId),k.accounts[0]);
  });
  it('revision change and expiry each release unused funds without pooling or transfer',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true});await reserve(p);
    await k.transaction('close-unused',k.controller.closeSequence(s.id,0));
    await k.transaction('cancel-closed',k.payments.connect(k.signers[1]).cancelReservation(s.id,p.c.legId));
    await k.transaction('refund-closed',k.payments.connect(k.signers[1]).withdraw(s.id,p.c.legId));
    const t=await k.open(),q=await k.consent(t,0,1,{funded:true});
    q.c.deadline=BigInt((await k.provider.getBlock('latest')).timestamp)+3n;q.signature=await sign(q.c);
    await reserve(q);
    // Local negative clock probe only; public testnet runner does not time-warp.
    await hre.network.provider.send('evm_increaseTime',[4]);await hre.network.provider.send('evm_mine');
    await k.transaction('cancel-expired',k.payments.connect(k.signers[1]).cancelReservation(t.id,q.c.legId));
    await k.transaction('refund-expired',k.payments.connect(k.signers[1]).withdraw(t.id,q.c.legId));
    assert.equal(await k.provider.getBalance(k.payments.target),0n);
  });
  it('changed authority blocks forward before nonce/token/funds change; transfer failure rolls consumption back',async()=>{
    const fault=await (await hre.ethers.getContractFactory('FaultingControlAsset')).deploy(k.accounts[0],k.owners[4]);
    await fault.waitForDeployment();const token=await fault.getAddress(),profile=await fault.verificationProfile();
    await k.transaction('open-negative',k.controller.openSequence(token,1,k.owners[4]));
    const id=await k.controller.currentSequence(token,1),amount=1000n;
    const c={sequenceId:id,expectedRevision:0,legId:k.uid('fault-reserve'),token,tokenId:1,
      fromAccount:k.accounts[0],toAccount:k.accounts[1],termsHash:await k.payments.termsHash(token,1,k.accounts[0],k.accounts[1],amount),
      inheritedHash:await k.controller.inheritedHash(id),returnAuthority:k.owners[4],returnConditionHash:k.conditionHash,
      evidenceAuthority:k.owners[4],deadline:BigInt((await k.provider.getBlock('latest')).timestamp)+3600n,recipientNonce:0,
      paymentAdapter:k.payments.target,paymentAmount:amount};
    const signature=await sign(c);await reserve({c,amount});
    await fault.configureRegistrar(k.owners[3]);
    await k.refused('authority-changed',()=>k.controller.forward.staticCall(c,signature),k.controller,'Unauthorized');
    assert.equal(await fault.ownerOf(1),k.accounts[0]);assert.equal(await k.controller.recipientNonces(k.owners[1]),0n);
    assert.equal((await k.payments.payment(id,c.legId)).state,6n);assert.equal((await k.controller.sequence(id)).revision,0n);
    await fault.configureRegistrar(k.owners[4]);await fault.configure(true,false,profile);
    await assert.rejects(k.controller.forward(c,signature,{gasLimit:1500000}));
    assert.equal((await k.payments.payment(id,c.legId)).state,6n);assert.equal(await k.controller.legCount(id),0n);
    await fault.configure(false,false,profile);
    await k.transaction('resume-forward',k.controller.forward(c,signature));assert.equal((await k.payments.payment(id,c.legId)).state,1n);
  });
});
