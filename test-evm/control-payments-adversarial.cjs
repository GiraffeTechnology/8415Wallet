const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario,FORWARD_FIELDS}=require('../scripts/controls/scenario-kit.cjs');

describe('Separate control payment and contract-owner boundaries',function(){
  this.timeout(180000);
  let k;
  beforeEach(async()=>{k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
    signers:await hre.ethers.getSigners(),artifact:name=>hre.artifacts.readArtifact(name)});});
  it('W-11: rejecting original payer remains refund-due; reentrancy cannot duplicate or revive return',async()=>{
    const Factory=await hre.ethers.getContractFactory('ControlOwnerAdversary');
    const owner=await Factory.deploy();await owner.waitForDeployment();
    const ownerAddress=await owner.getAddress();
    await k.transaction('adversarial-create-account',owner.execute(k.controllerAddress,k.controller.interface.encodeFunctionData('createAccount')));
    const controlled=await k.controller.accountOf(ownerAddress);
    const s=await k.open(),seq=await k.state(s),amount=1000n;
    const c={sequenceId:s.id,expectedRevision:seq.revision,legId:k.uid('1271-leg'),token:k.projectionAddress,tokenId:s.tokenId,
      fromAccount:k.accounts[0],toAccount:controlled,termsHash:await k.payments.termsHash(k.projectionAddress,s.tokenId,k.accounts[0],controlled,amount),
      inheritedHash:await k.controller.inheritedHash(s.id),returnAuthority:k.owners[4],returnConditionHash:k.conditionHash,
      evidenceAuthority:k.owners[4],deadline:BigInt((await k.provider.getBlock('latest')).timestamp)+3600n,recipientNonce:0n};
    assert.equal(await k.controller.validateRecipientSignature(c,'0xaabb'),false);
    const digest=hre.ethers.TypedDataEncoder.hash(k.domain,{ForwardConsent:FORWARD_FIELDS},c);
    await k.transaction('1271-exact-approval',owner.approveDigest(digest,true));
    assert.equal(await k.controller.validateRecipientSignature(c,'0xaabb'),true);
    await k.transaction('1271-forward',k.controller.forward(c,'0xaabb'));s.legs.push(c.legId);
    await k.transaction('1271-fund',owner.execute(await k.payments.getAddress(),k.payments.interface.encodeFunctionData('fund',[s.id,0]),{value:amount}));
    await k.beginReturn(s,1);await k.hop(s);
    await k.transaction('allocate-refund',k.payments.allocate(s.id,0));
    const payout=k.payments.interface.encodeFunctionData('withdraw',[s.id,c.legId]);
    await k.transaction('reject-native',owner.configure(true,hre.ethers.ZeroAddress,'0x'));
    await k.refused('payout-rejection',()=>owner.execute.staticCall(k.payments.target,payout),k.payments,'PayoutFailed');
    assert.equal((await k.payments.payment(s.id,c.legId)).state,3n);
    assert.equal((await k.controller.legAt(s.id,0)).outcome,3n);
    await k.transaction('enable-reentrant-probe',owner.configure(false,k.payments.target,payout));
    await k.transaction('withdraw-once',owner.execute(k.payments.target,payout));
    assert.equal(await owner.reenterSucceeded(),false);
    assert.equal((await k.payments.payment(s.id,c.legId)).state,5n);
    assert.equal(await k.provider.getBalance(ownerAddress),amount);
    await k.refused('duplicate-refund',()=>owner.execute.staticCall(k.payments.target,payout),k.payments,'InvalidPayment');
  });
  it('W-14: alternate approve/operator/controller/delegatecall surfaces cannot spend the protected token',async()=>{
    const s=await k.open();await k.forward(s,0,1);
    await assert.rejects(k.projection.connect(k.signers[1]).approve.staticCall(k.owners[2],s.tokenId));
    await assert.rejects(k.projection.connect(k.signers[1]).transferFrom.staticCall(k.accounts[1],k.accounts[2],s.tokenId));
    await k.transaction('irrelevant-EOA-operator',k.projection.connect(k.signers[1]).setApprovalForAll(k.owners[2],true));
    await assert.rejects(k.projection.connect(k.signers[2]).transferFrom.staticCall(k.accounts[1],k.accounts[2],s.tokenId));
    await k.refused('direct-control-transfer',()=>k.account(1).controlTransfer.staticCall(k.projectionAddress,s.tokenId,k.accounts[2]),k.account(1),'Unauthorized');
    for(const name of ['execute(address,bytes)','upgradeTo(address)','setApprovalForAll(address,bool)','delegatecall(address,bytes)']){
      const data=hre.ethers.id(name).slice(0,10)+'00'.repeat(128);
      await assert.rejects(k.provider.call({from:k.owners[1],to:k.accounts[1],data}));
    }
    assert.equal(await k.projection.ownerOf(s.tokenId),k.accounts[1]);
    assert.equal((await k.controller.legAt(s.id,0)).outcome,0n);
  });
  it('W-11/16: test-only fault injection rolls back a failed hop and rejects changed identity',async()=>{
    const Factory=await hre.ethers.getContractFactory('FaultingControlAsset');
    const fault=await Factory.deploy(k.accounts[0],k.owners[4]);await fault.waitForDeployment();
    const token=await fault.getAddress(),profile=await fault.verificationProfile();
    await k.transaction('open-fault-negative',k.controller.openSequence(token,1,k.owners[4]));
    const id=await k.controller.currentSequence(token,1);
    const c={sequenceId:id,expectedRevision:0,legId:k.uid('fault-leg'),token,tokenId:1,fromAccount:k.accounts[0],toAccount:k.accounts[1],
      termsHash:k.hash('test-terms'),inheritedHash:await k.controller.inheritedHash(id),returnAuthority:k.owners[4],
      returnConditionHash:k.conditionHash,evidenceAuthority:k.owners[4],deadline:BigInt((await k.provider.getBlock('latest')).timestamp)+3600n,recipientNonce:0};
    const signature=await k.signers[1].signTypedData(k.domain,{ForwardConsent:FORWARD_FIELDS},c);
    await k.transaction('forward-fault-negative',k.controller.forward(c,signature));
    await k.transaction('begin-fault-negative',k.controller.connect(k.signers[4]).beginReturn(id,c.legId,k.conditionHash,k.uid('evidence'),1));
    await fault.configure(true,false,profile);
    await assert.rejects(k.controller.connect(k.signers[4]).returnHop.staticCall(id,c.legId,2));
    assert.equal((await k.controller.sequence(id)).revision,2n);assert.equal((await k.controller.legAt(id,0)).outcome,2n);
    assert.equal(await fault.ownerOf(1),k.accounts[1]);
    await fault.configure(false,false,k.hash('different-profile'));
    await k.refused('identity-drift',()=>k.controller.connect(k.signers[4]).returnHop.staticCall(id,c.legId,2),k.controller,'ProjectionIdentityChanged');
    await fault.configure(false,false,profile);
    await k.transaction('resume-failed-hop',k.controller.connect(k.signers[4]).returnHop(id,c.legId,2));
    assert.equal((await k.controller.legAt(id,0)).outcome,3n);assert.equal(await fault.ownerOf(1),k.accounts[0]);
  });
});
