const assert=require('node:assert/strict');

// "AB detaches and the chain becomes BCDEF…" observed as data rather than
// asserted in prose. Every state transition records the same parameter set, so
// what a detachment changes — and what it deliberately leaves alone — is read
// from the table instead of being argued about.
//
// Two shapes are observed, because they fail differently:
//   continuous — A-B-C-D still trading while AB completes behind them;
//   ab-only    — a single leg, where detaching AB empties the window entirely.
//
// Both run on a local EVM and on a public testnet from the same code.
const ERC=['ownerOf','holder','finalNow','entryCount','entryVersion','entryEffectiveAt','gapOpen','gapOpenedAt'];
const CHAIN=['cursor','appended','completedCount','activeLegs','detachedCount','detachedCommitment',
  'boundaryAccount','currentAccount','inheritedHash'];

async function snapshot(k,s,state){
  const {projection,controller}=k;
  const seq=await controller.sequence(s.id);
  const entry=await projection.currentEntry(s.tokenId);
  const now=BigInt((await k.provider.getBlock('latest')).timestamp);
  // The chain answers the open gap as a settlement id; its openedAt is the
  // instant from which the token is contested, and it is read, never assumed.
  const gapId=await projection.openGapOf(s.tokenId);
  const gapOpen=gapId!==`0x${'0'.repeat(64)}`;
  const gapOpenedAt=gapOpen?String((await projection.settlement(gapId)).openedAt):'0';
  const [detachedCount,detachedCommitment]=await controller.detached(s.id);
  const label=a=>{const i=k.accounts.findIndex(x=>x.toLowerCase()===String(a).toLowerCase());
    return i<0?String(a).toLowerCase():['A','B','C','D','registrar'][i];};
  // Occurrence numbers are absolute: a detached one still names its place, and a
  // live one still reads its leg. Both are recorded, never inferred from cursor.
  const legs=[];
  for(let i=0n;i<seq.appended;i++){
    if(i<seq.completedCount){legs.push({occurrence:String(i),detached:true});continue;}
    const leg=await controller.legAt(s.id,i);
    legs.push({occurrence:String(i),detached:false,from:label(leg.fromAccount),to:label(leg.toAccount),
      outcome:Number(leg.outcome)});
  }
  return {state,
    erc:{ownerOf:label(await projection.ownerOf(s.tokenId)),
      holder:label(await projection.holderAsOf(s.tokenId,entry.effectiveAt)),
      finalNow:await projection.isFinalAsOf(s.tokenId,now),
      finalAtEntry:await projection.isFinalAsOf(s.tokenId,entry.effectiveAt),
      entryCount:String(await projection.entryCount(s.tokenId)),
      entryVersion:String(entry.version),entryEffectiveAt:String(entry.effectiveAt),
      gapOpen,gapOpenedAt,gapSettlementId:gapId},
    chain:{cursor:String(seq.cursor),appended:String(seq.appended),completedCount:String(seq.completedCount),
      activeLegs:String(await controller.activeLegCount(s.id)),detachedCount:String(detachedCount),
      detachedCommitment,boundaryAccount:label(await controller.boundaryAccount(s.id)),
      currentAccount:label(seq.currentAccount),inheritedHash:await controller.inheritedHash(s.id),
      revision:String(seq.revision)},
    legs};
}

async function observeDetachment(k,{shape}){
  assert.ok(['continuous','ab-only'].includes(shape),'DETACH_SHAPE_REFUSED');
  const s=await k.open();
  const states=[];
  const at=async label=>{const row=await snapshot(k,s,label);states.push(row);await k.record({kind:'detach-state',shape,...row});return row;};
  // Open a gap, observe the contested state, then cancel it. No proof is
  // admitted, so nothing about the register's answer may change.
  k.contest=async(scenario,expectedIndex)=>{
    const registrar=k.signers[4];
    const settlementId=k.uid('observed-gap');
    // The window up to the deadline belongs to the proof, so a gap cannot be
    // cancelled before it passes. Take the shortest legitimate window and wait
    // for the chain's own clock rather than warping it.
    const deadline=BigInt((await k.provider.getBlock('latest')).timestamp)+3n;
    await k.transaction('begin-observed-gap',k.projection.connect(registrar)
      .beginSettlement(scenario.tokenId,settlementId,k.accounts[expectedIndex],k.uid('observed-snapshot'),deadline));
    const row=await at('gap-open');
    // A public chain produces blocks by itself; a development chain only mines
    // on demand. Find out which this is by watching, rather than warping time
    // or assuming, and only nudge a chain that needs it.
    const clock=async()=>BigInt((await k.provider.getBlock('latest')).timestamp);
    const observed=await clock();
    await new Promise(r=>setTimeout(r,2500));
    const selfMining=await clock()>observed;
    const until=Date.now()+180000;
    while(await clock()<=deadline){
      assert.ok(Date.now()<until,'DETACH_BLOCK_CLOCK_TIMEOUT');
      if(!selfMining)await k.transaction('advance-clock',
        registrar.sendTransaction({to:await registrar.getAddress(),value:0n}));
      else await new Promise(r=>setTimeout(r,2000));
    }
    await k.transaction('cancel-observed-gap',k.projection.connect(registrar)
      .cancelSettlement(settlementId,k.hash('TEST_ONLY observation cancelled')));
    return row;
  };

  const opened=await at('opened');
  assert.equal(opened.chain.activeLegs,'0');
  assert.equal(opened.chain.boundaryAccount,'A','the window starts at the opening account');

  if(shape==='continuous'){
    await k.forward(s,0,1); const ab=await at('forwarded-AB');
    await k.forward(s,1,2); await at('forwarded-BC');
    await k.forward(s,2,3); const abcd=await at('forwarded-ABCD');
    assert.equal(ab.chain.activeLegs,'1'); assert.equal(abcd.chain.activeLegs,'3');
    assert.equal(abcd.erc.ownerOf,'D','the position ran ahead while the register lagged');
    assert.equal(abcd.erc.holder,'A','the register still confirms A');

    // A gap open over the same token is a third, separate signal. It is observed
    // and then cancelled, because cancellation ends the contest and settles
    // nothing: the projection is unchanged and the prior entry stays in force.
    const contested=await k.contest(s,1);
    assert.equal(contested.erc.gapOpen,true);
    assert.notEqual(contested.erc.gapOpenedAt,'0');
    assert.equal(contested.erc.entryCount,abcd.erc.entryCount,'an open gap admits nothing');
    assert.equal(contested.erc.holder,abcd.erc.holder,'an open gap does not move the confirmed holder');
    assert.equal(contested.chain.activeLegs,abcd.chain.activeLegs,'a gap is not a responsibility state');
    const cancelled=await at('gap-cancelled');
    assert.equal(cancelled.erc.gapOpen,false);
    assert.equal(cancelled.erc.entryCount,abcd.erc.entryCount,'cancellation admitted nothing');
    assert.equal(cancelled.erc.entryVersion,abcd.erc.entryVersion,'the prior entry stays in force');
    assert.equal(cancelled.erc.finalNow,abcd.erc.finalNow,'a closed gap is not temporal finality');

    await k.admit(s,1); const admitted=await at('admitted-B');
    assert.equal(admitted.erc.holder,'B');
    assert.equal(admitted.chain.completedCount,'0','an admission is not a completion');

    await k.complete(s,1); const detached=await at('detached-AB');
    assert.equal(detached.chain.completedCount,'1');
    assert.equal(detached.chain.activeLegs,'2','the window is BC and CD; AB no longer occupies a slot');
    assert.equal(detached.chain.detachedCount,'1');
    assert.notEqual(detached.chain.detachedCommitment,`0x${'0'.repeat(64)}`);
    assert.equal(detached.chain.boundaryAccount,'B','a return now stops at B, never crossing AB');
    assert.equal(detached.legs[0].detached,true,'occurrence 0 reads as detached, never as a zeroed record');
    assert.equal(detached.erc.ownerOf,'D','detachment moved no token');
    assert.equal(detached.erc.entryCount,admitted.erc.entryCount,'detachment admitted no entry');
    assert.equal(detached.erc.finalNow,admitted.erc.finalNow,'detachment is not temporal finality');

    // The chain keeps rolling behind the detached prefix: ABCDEF… continues.
    await k.forward(s,3,1); const extended=await at('extended-DB-after-detach');
    assert.equal(extended.chain.appended,'4','occurrence numbers keep counting past a detached leg');
    assert.equal(extended.chain.activeLegs,'3','only unresolved legs occupy the window');
    assert.equal(extended.chain.detachedCount,'1');
    assert.equal(extended.chain.boundaryAccount,'B','a later trade does not move the boundary');
    return {shape,sequenceId:s.id,tokenId:String(s.tokenId),states};
  }

  await k.forward(s,0,1); const only=await at('forwarded-AB');
  assert.equal(only.chain.activeLegs,'1');
  assert.equal(only.erc.ownerOf,'B'); assert.equal(only.erc.holder,'A');

  await k.admit(s,1); const admitted=await at('admitted-B');
  assert.equal(admitted.erc.holder,'B');
  assert.equal(admitted.erc.ownerOf,'B','owner and holder agree here — which is still not verified identity');

  await k.complete(s,1); const detached=await at('detached-AB');
  assert.equal(detached.chain.activeLegs,'0','the window is empty: the chain became nothing, not BCDEF');
  assert.equal(detached.chain.completedCount,'1');
  assert.equal(detached.chain.detachedCount,'1');
  assert.equal(detached.chain.boundaryAccount,'B');
  assert.equal(detached.legs[0].detached,true);
  assert.equal(detached.erc.ownerOf,'B','detachment moved no token');
  assert.equal(detached.erc.entryCount,admitted.erc.entryCount,'detachment admitted no entry');

  // An empty window still extends: B may sell on, and the new leg is occurrence 1.
  await k.forward(s,1,2); const reopened=await at('forwarded-BC-after-empty');
  assert.equal(reopened.chain.appended,'2');
  assert.equal(reopened.chain.activeLegs,'1');
  assert.equal(reopened.chain.detachedCount,'1');
  assert.equal(reopened.chain.boundaryAccount,'B');
  return {shape,sequenceId:s.id,tokenId:String(s.tokenId),states};
}

async function runDetachObservations(k){
  const results=[];
  for(const shape of ['continuous','ab-only']){
    const result=await observeDetachment(k,{shape});
    await k.record({kind:'journey',name:`detachment-${shape}`,sequenceId:result.sequenceId,
      tokenId:result.tokenId,statesObserved:result.states.length,assertionsCompleted:true});
    results.push(result);
  }
  return results;
}
module.exports={observeDetachment,runDetachObservations,snapshot,ERC,CHAIN};
