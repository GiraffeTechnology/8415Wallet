const assert=require('node:assert/strict');
const hre=require('hardhat');
const {createScenario}=require('../scripts/controls/scenario-kit.cjs');

// Real local EVM integration, not a browser wallet or public-testnet claim.
describe('V3 production SDK against actual local EVM contracts',function(){
  this.timeout(180000);
  let k,sdk,pin,payment,token;
  before(async()=>{sdk=await import('../src/controls/index.ts');});
  beforeEach(async()=>{
    k=await createScenario({ethers:hre.ethers,provider:hre.ethers.provider,signers:await hre.ethers.getSigners(),artifact:n=>hre.artifacts.readArtifact(n)});
    const bind=async address=>({chainId:k.domain.chainId,controller:address.toLowerCase(),runtimeCodeHash:hre.ethers.keccak256(await k.provider.getCode(address))});
    pin=await bind(k.controllerAddress);payment=await bind(await k.payments.getAddress());token=await bind(k.projectionAddress);
  });
  function session(index,withPayment=false){
    // Only account selection is fixture-owned. Calls, signatures, transactions,
    // block-hash reads, receipts and event bytes execute on the actual local EVM.
    const provider={request:async({method,params=[]})=>method==='eth_accounts'?[k.owners[index]]:hre.network.provider.request({method,params})};
    let stored=null;
    const store={read:async()=>structuredClone(stored),compareAndSwap:async(expected,next)=>{
      if((stored?.revision??null)!==expected)return false;stored=sdk.parseOperation(sdk.serializeOperation(next));return true;
    }};
    return new sdk.ResponsibilityWalletSession(provider,pin,k.owners[index],store,withPayment?payment:null);
  }
  async function execute(s,operation){
    const result=await s.execute(operation);assert.equal((await s.reconcile()).state,'confirmed');
    await s.acknowledgeTerminal(result.transactionHash);assert.equal((await s.status()).status,'idle');return result;
  }
  const condition='TEST_ONLY accepted registrar attestation of this leg failure';
  const docs=()=>({incoming:{terms:{scheme:'utf8-keccak256',text:'TEST_ONLY unfunded responsibility'},returnConditionText:condition},inherited:[]});
  it('reviews exact terms, signs, forwards, reads independent facts, completes and exits via SDK',async()=>{
    const s=await k.open(),a=session(0),b=session(1),p=await k.consent(s,0,1);
    assert.equal(sdk.forwardConsentDigest(pin,p.c),await k.controller.consentDigest(p.c));
    await assert.rejects(b.consent.prepare(p.c,k.owners[1],{...docs(),incoming:{...docs().incoming,returnConditionText:'not accepted'}}),/CONTROL_CONDITION_DOCUMENT_MISMATCH/);
    const review=await b.consent.prepare(p.c,k.owners[1],docs());assert.equal(Object.isFrozen(review),true);
    await assert.rejects(b.consent.accept({...review},review.digest),/CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED/);
    const signature=await b.consent.accept(review,review.digest);
    await assert.rejects(b.consent.accept(review,review.digest),/CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED/);
    const sent=await execute(a,{kind:'control',action:{kind:'forward',consent:p.c,recipientSignature:signature}});s.legs.push(p.c.legId);
    assert.equal(sdk.serializeControlSubmission(sent).includes(signature),false);
    const before=await a.reader.observe(s.id);assert.equal(before.projection.owner,k.accounts[1].toLowerCase());
    assert.equal(before.projection.holder,k.accounts[0].toLowerCase());assert.equal(before.evidence.kind,'unavailable');
    await k.admit(s,1);
    await execute(a,{kind:'control',action:{kind:'complete',sequenceId:s.id,throughLegId:p.c.legId,expectedRevision:(await k.state(s)).revision}});
    const after=await a.reader.observe(s.id);
    // The leg completed and left the chain: the window is empty and the record
    // is at the register, covered by the detachment commitment.
    assert.equal(after.snapshot.legs.length,0);
    const gone=await k.controller.detached(s.id);
    assert.equal(gone.count,1n);
    assert.equal(await k.controller.legTerminalOutcome(s.id,p.c.legId),1n);
    assert.equal(after.projection.protocolFinality,false);assert.equal(after.evidence.kind,'bound');
    await execute(b,{kind:'control',action:{kind:'close-sequence',sequenceId:s.id,expectedRevision:(await k.state(s)).revision}});
    await execute(b,{kind:'standalone-withdraw',token,tokenId:s.tokenId,destination:k.owners[1]});
    assert.equal(await k.projection.ownerOf(s.tokenId),k.owners[1]);
  });
  it('discloses active upstream obligations and SDK payment receipts remain separate from returns',async()=>{
    const s=await k.open();const p=await k.forward(s,0,1,{funded:true});
    const next=await k.consent(s,1,2),c=session(2),b=session(1,true),r=session(4,true);
    await assert.rejects(c.consent.prepare(next.c,k.owners[2],docs()),/CONTROL_DISCLOSURE_SCOPE_REFUSED/);
    const full={...docs(),inherited:[{legId:p.c.legId,terms:{scheme:'native-payment-v1',adapter:payment.controller,amount:1000n},returnConditionText:condition}]};
    const review=await c.consent.prepare(next.c,k.owners[2],full);
    assert.equal(review.inherited.length,1);assert.equal(review.inherited[0].returnAuthority,k.owners[4].toLowerCase());
    assert.equal((await b.payments.read(s.id,p.c.legId)).state,'funded');
    await k.beginReturn(s,1);
    await assert.rejects(b.execute({kind:'allocate',sequenceId:s.id,legId:p.c.legId}),/CONTROL_PAYMENT_OUTCOME_REFUSED/);
    await execute(r,{kind:'control',action:{kind:'return-hop',sequenceId:s.id,legId:p.c.legId,expectedRevision:(await k.state(s)).revision}});
    await execute(b,{kind:'allocate',sequenceId:s.id,legId:p.c.legId});
    assert.equal((await b.payments.read(s.id,p.c.legId)).state,'refund-due');
    await execute(b,{kind:'payout',sequenceId:s.id,legId:p.c.legId});
    assert.equal((await b.payments.read(s.id,p.c.legId)).state,'refunded');
    assert.equal((await b.reader.observe(s.id)).snapshot.legs[0].outcome,'returned');
  });
  it('SDK reserves exact reviewed consent and can refund unused funds after explicit invalidation',async()=>{
    const s=await k.open(),p=await k.consent(s,0,1,{funded:true}),a=session(0,true),b=session(1,true);
    const documents={incoming:{terms:{scheme:'native-payment-v1',adapter:payment.controller,amount:p.amount},returnConditionText:condition},inherited:[]};
    const review=await b.consent.prepare(p.c,k.owners[1],documents);
    const signature=await b.consent.accept(review,review.digest);
    await execute(b,{kind:'reserve-payment',consent:p.c});assert.equal((await b.payments.read(s.id,p.c.legId)).state,'reserved');
    await execute(a,{kind:'control',action:{kind:'forward',consent:p.c,recipientSignature:signature}});
    assert.equal((await b.payments.read(s.id,p.c.legId)).state,'funded');
    const t=await k.open(),q=await k.consent(t,0,1,{funded:true});
    await execute(b,{kind:'reserve-payment',consent:q.c});
    await execute(b,{kind:'control',action:{kind:'invalidate-consent',nextNonce:q.c.recipientNonce+1n}});
    await execute(b,{kind:'cancel-reservation',sequenceId:t.id,legId:q.c.legId});
    await execute(b,{kind:'payout',sequenceId:t.id,legId:q.c.legId});
    assert.equal((await b.payments.read(t.id,q.c.legId)).state,'refunded');
  });
  it('recovers a real nonce race only after a different canonical transaction, without retrying the intended send',async()=>{
    const sequence=await k.open();
    let stored=null,replacement=null,sends=0;
    const provider={request:async({method,params=[]})=>{
      if(method==='eth_accounts')return [k.owners[0]];
      if(method==='eth_sendTransaction'){
        sends++;
        replacement=await hre.network.provider.request({method,params:[{from:k.owners[0],to:k.owners[1],value:'0x0',nonce:params[0].nonce}]});
        throw new Error('simulated wallet rejected original after another transaction consumed nonce');
      }
      return hre.network.provider.request({method,params});
    }};
    const store={read:async()=>structuredClone(stored),compareAndSwap:async(expected,next)=>{
      if((stored?.revision??null)!==expected)return false;stored=sdk.parseOperation(sdk.serializeOperation(next));return true;
    }};
    const wallet=new sdk.ResponsibilityWalletSession(provider,pin,k.owners[0],store);
    await assert.rejects(wallet.execute({kind:'control',action:{kind:'close-sequence',sequenceId:sequence.id,expectedRevision:(await k.state(sequence)).revision}}));
    assert.equal(stored.status,'outcome-unknown');assert.equal(sends,1);
    await assert.rejects(wallet.acknowledgeSupersededNonce(replacement,2n),/CONTROL_REPLACEMENT_CONFIRMATIONS_REQUIRED/);
    await hre.network.provider.request({method:'evm_mine',params:[]});
    const proof=await wallet.acknowledgeSupersededNonce(replacement,2n);
    assert.equal(proof.originalExecutionConfirmed,false);assert.equal(stored.status,'idle');assert.equal(sends,1);
  });
});
