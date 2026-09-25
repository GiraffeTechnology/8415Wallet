const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario}=require('../scripts/controls/scenario-kit.cjs');

/**
 * The chain is a rolling window, not a fixed-length run.
 *
 * A->B->C->D... keeps extending while completed heads detach behind it, so the
 * active chain becomes BCDEF..., then CDEF..., and a token that keeps trading is
 * never stopped by how much it has already traded. The window bounds what is
 * UNRESOLVED; retained history is uncapped.
 *
 * Before this, the cap counted every leg ever pushed, so a sequence died at the
 * 128th hop even with nothing active - and if it still carried a tail at that
 * point it could neither forward nor close, which left the token stuck.
 */
describe('W-22: a chain that keeps trading while heads detach',function(){
  this.timeout(900000);
  let k, MAX;
  beforeEach(async()=>{
    k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
      signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)});
    MAX=Number(await k.controller.MAX_ACTIVE_LEGS());
  });

  it('rolls past the window as completed prefixes leave it', async()=>{
    const s=await k.open();
    // Trade well past the window, registering and detaching each head.
    const hops=MAX+12;
    let at=0;
    for(let i=0;i<hops;i++){
      const to=(at+1)%4;
      await k.forward(s,at,to); at=to;
      await k.admit(s,i+1);
      await k.complete(s,i+1);
    }
    const st=await k.state(s);
    assert.equal(await k.controller.legCount(s.id),BigInt(hops),'history is retained in full');
    assert.equal(st.completedCount,BigInt(hops));
    assert.equal(st.cursor-st.completedCount,0n,'nothing unresolved');
    assert.ok(hops>MAX,'the run must exceed the window to prove the point');
    // And it can still go on: being past the window is not a terminal state.
    await k.forward(s,at,(at+1)%4);
    assert.equal(await k.controller.legCount(s.id),BigInt(hops+1));
  });

  it('refuses the leg that would exceed the UNRESOLVED window', async()=>{
    const s=await k.open();
    let at=0;
    for(let i=0;i<MAX;i++){ const to=(at+1)%4; await k.forward(s,at,to); at=to; }
    const st=await k.state(s);
    assert.equal(st.cursor-st.completedCount,BigInt(MAX),'window is full and all of it is unresolved');
    await k.refused('window-full',async()=>{
      const p=await k.consent(s,at,(at+1)%4);
      return k.controller.connect(k.signers[at]).forward.staticCall(p.c,p.signature);
    },k.controller,'InvalidInput');

    // Detaching one head frees exactly one slot, and the chain moves again.
    await k.admit(s,1); await k.complete(s,1);
    const to=(at+1)%4;
    await k.forward(s,at,to);
    const after=await k.state(s);
    assert.equal(after.cursor-after.completedCount,BigInt(MAX),'window stays full, not exceeded');
    assert.equal(await k.controller.legCount(s.id),BigInt(MAX+1),'history grew past the window');
  });

  it('inherited conditions still bind after heads detach', async()=>{
    // inheritedHash now starts at the active window. If that dropped a live
    // condition, a recipient could accept less than it owes and this would pass.
    const s=await k.open();
    await k.forward(s,0,1); await k.forward(s,1,2);
    await k.admit(s,1); await k.complete(s,1);          // AB detaches; BC stays live
    const live=await k.controller.inheritedHash(s.id);
    assert.notEqual(live,hre.ethers.ZeroHash);

    const p=await k.consent(s,2,3);
    assert.equal(p.c.inheritedHash,live,'consent must carry the live tail');
    await k.refused('substituted-inheritance-after-detach',
      ()=>k.controller.connect(k.signers[2]).forward.staticCall(
        {...p.c,inheritedHash:k.hash('dropped upstream condition')},p.signature),
      k.controller,'InheritanceMismatch');
    // The accepted one goes through, so the digest is live rather than merely strict.
    await k.forward(s,2,3);
  });

  it('a detached head is not revived by later trading', async()=>{
    const s=await k.open();
    await k.forward(s,0,1); await k.admit(s,1); await k.complete(s,1);
    await k.forward(s,1,2); await k.forward(s,2,3);
    // AB is gone: it cannot be the root of a return, however far the chain runs.
    await k.refused('detached-head-return',
      async()=>k.controller.connect(k.signers[4]).beginReturn.staticCall(
        s.id,s.legs[0],k.conditionHash,k.uid('evidence'),(await k.state(s)).revision),
      k.controller,'ReturnBoundaryRefused');
    // The record left the chain with the leg; what stays is the terminal fact
    // and the commitment the register's copy checks against.
    await k.refused('detached-record-not-on-chain',()=>k.controller.legAt.staticCall(s.id,0),k.controller,'LegAtRegister');
    assert.equal(await k.controller.legTerminalOutcome(s.id,s.legs[0]),1n);
  });
});

/**
 * W-23: a completed trade is not carried by the chain.
 *
 * The record leaves with the leg. What stays is a constant-size commitment over
 * everything that has left and the bare fact that it terminated - the minimum an
 * attached payment needs to settle a leg that is already gone. The record itself
 * goes to the register through the detachment log, and what the register returns
 * checks back against the commitment.
 */
describe('W-23: a completed trade leaves the chain',function(){
  this.timeout(900000);
  let k;
  beforeEach(async()=>{ k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,
    signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)}); });

  it('deletes the record, keeps a commitment, and publishes it for the register',async()=>{
    const s=await k.open();
    await k.forward(s,0,1); await k.forward(s,1,2);
    const before=await k.controller.legAt(s.id,0);
    const empty=await k.controller.detached(s.id);
    assert.equal(empty.count,0n);
    assert.equal(empty.commitment,hre.ethers.ZeroHash,'nothing has detached yet');

    await k.admit(s,1);
    const receipt=await k.transaction('detach-head',
      k.controller.completeThrough(s.id,s.legs[0],(await k.state(s)).revision));

    // Gone from state, and said so rather than answered with zeroes.
    await k.refused('record-not-on-chain',()=>k.controller.legAt.staticCall(s.id,0),k.controller,'LegAtRegister');

    // The whole record is in the log, which is the register's copy.
    const logs=await k.controller.queryFilter(k.controller.filters.LegDetached(s.id),receipt.blockNumber,receipt.blockNumber);
    assert.equal(logs.length,1);
    const published=logs[0].args;
    assert.equal(published.legId,before.id);
    assert.equal(published.fromAccount,before.fromAccount);
    assert.equal(published.toAccount,before.toAccount);
    assert.equal(published.termsHash,before.termsHash);
    assert.equal(published.acceptanceHash,before.acceptanceHash);
    assert.equal(published.returnAuthority,before.returnAuthority);
    assert.equal(published.returnConditionHash,before.returnConditionHash);

    // And the commitment on chain is exactly what that record folds to, so a
    // register handing back this row can be checked rather than trusted.
    const after=await k.controller.detached(s.id);
    assert.equal(after.count,1n);
    const coder=hre.ethers.AbiCoder.defaultAbiCoder();
    const seed=hre.ethers.keccak256(coder.encode(['bytes32','bytes32'],
      [hre.ethers.keccak256(hre.ethers.toUtf8Bytes('8415Wallet/DetachedResponsibilities/v1')),s.id]));
    const expected=hre.ethers.keccak256(coder.encode(
      ['bytes32','uint256','bytes32','address','address','bytes32','bytes32','address','bytes32'],
      [seed,0n,before.id,before.fromAccount,before.toAccount,before.termsHash,
       before.acceptanceHash,before.returnAuthority,before.returnConditionHash]));
    assert.equal(after.commitment,expected,'the commitment must fold the published record');
    assert.equal(published.detachedCommitment,expected);
  });

  it('cannot be named again, and still settles an attached payment',async()=>{
    const s=await k.open();
    await k.forward(s,0,1,{funded:true});
    await k.forward(s,1,2);
    await k.admit(s,1);
    await k.complete(s,1);

    // Its id is no longer a completion target or a return boundary.
    await k.refused('recomplete-detached',async()=>k.controller.completeThrough.staticCall(
      s.id,s.legs[0],(await k.state(s)).revision),k.controller,'CompletionConditionUnsatisfied');
    await k.refused('return-through-detached',async()=>k.controller.connect(k.signers[4]).beginReturn.staticCall(
      s.id,s.legs[0],k.conditionHash,k.uid('evidence'),(await k.state(s)).revision),k.controller,'ReturnBoundaryRefused');

    // The payment still settles: the terminal fact outlives the trade record,
    // and payer, payee and amount come from the payment adapter's own record.
    assert.equal(await k.controller.legTerminalOutcome(s.id,s.legs[0]),1n);
    await k.payout(s,0,0,4n);
    assert.equal((await k.payments.payment(s.id,s.legs[0])).state,4n);
  });

  it('the boundary still resolves, so a lagging register can bind there',async()=>{
    const s=await k.open();
    await k.forward(s,0,1); await k.forward(s,1,2);
    await k.admit(s,1); await k.complete(s,1);
    // Occurrence 1 detached, and it is the boundary: the window starts at the
    // account it handed the token to, which the chain still knows.
    await k.admit(s,1);
    assert.equal((await k.state(s)).completedCount,1n);
  });
});
