const assert = require('node:assert/strict');

// Same real reference admission path for local EVM and public testnet. No mock
// projection, time warp, skipped assertion or hard-coded PASS count in this kit.
const FORWARD_FIELDS = [
  ['sequenceId','bytes32'],['expectedRevision','uint256'],['legId','bytes32'],['token','address'],
  ['tokenId','uint256'],['fromAccount','address'],['toAccount','address'],['termsHash','bytes32'],
  ['inheritedHash','bytes32'],['returnAuthority','address'],['returnConditionHash','bytes32'],
  ['evidenceAuthority','address'],['deadline','uint64'],['recipientNonce','uint256'],
].map(([name,type]) => ({name,type}));

async function createScenario({ ethers, provider, signers, artifact, record = async () => {}, confirmations = 1, timeout = 180000 }) {
  assert.ok(signers.length >= 5, 'SCENARIO_FIVE_ISOLATED_SIGNERS_REQUIRED');
  const [A,B,C,D,registrar] = signers;
  const owners = await Promise.all(signers.slice(0,5).map(s => s.getAddress()));
  assert.equal(new Set(owners.map(x => x.toLowerCase())).size, 5, 'SCENARIO_DISTINCT_ROLES_REQUIRED');
  const chainId = (await provider.getNetwork()).chainId;
  const hash = label => ethers.keccak256(ethers.toUtf8Bytes(label));
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let serial = 0;
  const uid = label => hash(`${label}:${++serial}`);
  async function transaction(label, promise) {
    const tx = await promise; const receipt = await tx.wait(confirmations, timeout);
    assert.ok(receipt && receipt.status === 1, 'SCENARIO_TRANSACTION_NOT_SUCCESSFUL');
    const block = await provider.getBlock(receipt.blockNumber);
    assert.equal(block?.hash, receipt.blockHash, 'SCENARIO_RECEIPT_REORGED');
    await record({ kind: 'transaction', label, chainId: chainId.toString(), hash: receipt.hash,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
    return receipt;
  }
  async function deploy(name, args) {
    const a = await artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, A).deploy(...args);
    await transaction(`deploy:${name}`, Promise.resolve(c.deploymentTransaction()));
    await c.waitForDeployment();
    const address = await c.getAddress(); const code = await provider.getCode(address);
    assert.notEqual(code, '0x', 'SCENARIO_DEPLOYMENT_CODE_MISSING');
    await record({ kind: 'deployment', name, address, runtimeCodeHash: ethers.keccak256(code), chainId: chainId.toString() });
    return c;
  }
  // Disposable test-only registrar validators. Kept in process memory; no key or
  // signature is recorded. They model an explicit test trust profile, not a real register.
  const validators = [ethers.Wallet.createRandom(),ethers.Wallet.createRandom(),ethers.Wallet.createRandom()]
    .sort((a,b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const validatorAddresses = validators.map(w => w.address);
  const setHash = ethers.keccak256(coder.encode(['address[]','uint8'], [validatorAddresses,2]));
  const registerId = hash('8415Wallet V3 TEST_ONLY_NO_REAL_VALUE register');
  const projection = await deploy('RegisterProjectionReference', [registerId,owners[4],validatorAddresses,2]);
  const controller = await deploy('ResponsibilityController', []);
  const payments = await deploy('NativeResponsibilityPayments', [await controller.getAddress()]);
  const accounts = [];
  for (let i=0; i<4; i++) {
    await transaction(`create-account:${i}`,controller.connect(signers[i]).createAccount());
    const account = await controller.accountOf(owners[i]); accounts.push(account);
    assert.equal(await controller.registeredAccount(account), true);
  }
  const accountArtifact = await artifact('ControlledWallet');
  const account = i => new ethers.Contract(accounts[i],accountArtifact.abi,signers[i]);
  const projectionAddress = await projection.getAddress();
  const controllerAddress = await controller.getAddress();
  const domain = {name:'8415Wallet ResponsibilityControls',version:'1',chainId,verifyingContract:controllerAddress};
  const leafType = hash('RemoteEntry(uint256 localChainId,address localContract,uint256 tokenId,bytes32 settlementId,address holder,bytes32 snapshotHash,bytes32 previousCommitment,bytes32 recordCommitment,bytes32 registryReference,uint64 version,uint64 effectiveAt)');
  const finalityType = hash('RemoteFinality(bytes32 remoteRegisterId,uint64 remoteHeight,bytes32 remoteBlockHash,bytes32 remoteStateRoot,bytes32 validatorSetHash)');
  let tokenCounter=0n, remoteHeight=0n;
  const conditionText='TEST_ONLY accepted registrar attestation of this leg failure';
  const conditionHash=hash(conditionText);
  async function open() {
    const tokenId=++tokenCounter;
    const now=BigInt((await provider.getBlock('latest')).timestamp);
    await transaction('mint-test-token',projection.mint(accounts[0],tokenId,uid('genesis'),uid('reference'),now-3600n));
    await transaction('open-sequence',controller.openSequence(projectionAddress,tokenId,owners[4]));
    const id=await controller.currentSequence(projectionAddress,tokenId);
    return {id,tokenId,legs:[]};
  }
  const state = s => controller.sequence(s.id);
  async function consent(s,from,to,{funded=false}={}) {
    const seq=await state(s); const amount=1000n;
    const termsHash=funded ? await payments.termsHash(projectionAddress,s.tokenId,accounts[from],accounts[to],amount) : hash('TEST_ONLY unfunded responsibility');
    const c={sequenceId:s.id,expectedRevision:seq.revision,legId:uid('leg'),token:projectionAddress,tokenId:s.tokenId,
      fromAccount:accounts[from],toAccount:accounts[to],termsHash,inheritedHash:await controller.inheritedHash(s.id),
      returnAuthority:owners[4],returnConditionHash:conditionHash,evidenceAuthority:owners[4],
      deadline:BigInt((await provider.getBlock('latest')).timestamp)+3600n,recipientNonce:await controller.recipientNonces(owners[to])};
    const signature=await signers[to].signTypedData(domain,{ForwardConsent:FORWARD_FIELDS},c);
    assert.equal(await controller.validateRecipientSignature(c,signature),true,'SCENARIO_VALID_CONSENT_REFUSED');
    return {c,signature,amount,from,to,funded};
  }
  async function forward(s,from,to,options={}) {
    const prepared=await consent(s,from,to,options);
    await transaction('forward',controller.connect(signers[from]).forward(prepared.c,prepared.signature));
    s.legs.push(prepared.c.legId);
    assert.equal(await projection.ownerOf(s.tokenId),accounts[to]);
    if (options.funded) {
      await transaction('fund-leg',payments.connect(signers[to]).fund(s.id,s.legs.length-1,{value:prepared.amount}));
      const p=await payments.payment(s.id,prepared.c.legId);
      assert.equal(p.state,1n); assert.equal(p.payer,owners[to]); assert.equal(p.payee,owners[from]); assert.equal(p.amount,prepared.amount);
    }
    return prepared;
  }
  async function admit(s,occurrence) {
    const previous=await projection.currentEntry(s.tokenId);
    const seq=await state(s);
    // A detached occurrence has no leg to read. The boundary is the one the chain
    // still answers for, which is exactly the occurrence a lagging register binds.
    const seqNow=await state(s);
    const holder=occurrence===0 ? accounts[0]
      : BigInt(occurrence)<=seqNow.completedCount ? await controller.boundaryAccount(s.id)
      : (await controller.legAt(s.id,occurrence-1)).toAccount;
    const settlementId=uid('settlement'), snapshot=uid('snapshot'), commitment=uid('commitment'), reference=uid('registry-reference');
    const now=BigInt((await provider.getBlock('latest')).timestamp);
    const effectiveAt=now > previous.effectiveAt ? now : previous.effectiveAt+1n;
    // No synthetic time warp: if a public block has not advanced, wait boundedly for it.
    const deadline=Date.now()+timeout;
    while (BigInt((await provider.getBlock('latest')).timestamp)<effectiveAt) {
      assert.ok(Date.now()<deadline,'SCENARIO_BLOCK_CLOCK_TIMEOUT'); await new Promise(r=>setTimeout(r,1000));
    }
    await transaction('begin-register-gap',projection.connect(registrar).beginSettlement(s.tokenId,settlementId,holder,snapshot,now+3600n));
    const leafStruct=ethers.keccak256(coder.encode(
      ['bytes32','uint256','address','uint256','bytes32','address','bytes32','bytes32','bytes32','bytes32','uint64','uint64'],
      [leafType,chainId,projectionAddress,s.tokenId,settlementId,holder,snapshot,previous.recordCommitment,commitment,reference,previous.version+1n,effectiveAt]));
    const root=ethers.keccak256(ethers.concat(['0x00',leafStruct]));
    const height=++remoteHeight, remoteBlock=uid('test-remote-block');
    const structHash=ethers.keccak256(coder.encode(['bytes32','bytes32','uint64','bytes32','bytes32','bytes32'],[finalityType,registerId,height,remoteBlock,root,setHash]));
    const digest=ethers.keccak256(ethers.concat(['0x1901',await projection.DOMAIN_SEPARATOR(),structHash]));
    const signatures=validators.slice(0,2).map(w=>ethers.Signature.from(w.signingKey.sign(digest)).serialized);
    const proof=coder.encode(['uint64','bytes32','bytes32','uint256','bytes32[]','bytes[]'],[height,remoteBlock,root,0n,[],signatures]);
    await transaction('admit-test-register-proof',projection.finalizeSettlement(settlementId,commitment,reference,effectiveAt,proof));
    await transaction('bind-admitted-occurrence',controller.connect(registrar).bindAdmission(s.id,occurrence,previous.version+1n,seq.revision));
    assert.equal(await projection.holderAsOf(s.tokenId,effectiveAt),holder);
    return previous.version+1n;
  }
  async function complete(s,through) {
    await transaction('complete-prefix',controller.completeThrough(s.id,s.legs[through-1],(await state(s)).revision));
    assert.equal((await state(s)).completedCount,BigInt(through));
  }
  async function beginReturn(s,root) {
    await transaction('begin-accepted-return',controller.connect(registrar).beginReturn(s.id,s.legs[root-1],conditionHash,uid('trigger-evidence'),(await state(s)).revision));
  }
  async function hop(s) {
    const seq=await state(s); const leg=await controller.legAt(s.id,seq.cursor-1n);
    await transaction('actual-return-hop',controller.connect(registrar).returnHop(s.id,leg.id,seq.revision));
    assert.equal(await projection.ownerOf(s.tokenId),leg.fromAccount);
    assert.equal((await controller.legAt(s.id,seq.cursor-1n)).outcome,3n);
  }
  async function payout(s,index,ownerIndex,terminal) {
    await transaction('allocate-payment',payments.allocate(s.id,s.legs[index]));
    await transaction('withdraw-payment',payments.connect(signers[ownerIndex]).withdraw(s.id,s.legs[index]));
    assert.equal((await payments.payment(s.id,s.legs[index])).state,terminal);
  }
  async function refused(label,fn,contract,errorName) {
    let code=null;
    try { await fn(); } catch(e) {
      const data=typeof e?.data==='string' ? e.data : typeof e?.info?.error?.data==='string' ? e.info.error.data : null;
      if (data) { try { code=contract.interface.parseError(data)?.name ?? null; } catch {} }
    }
    assert.equal(code,errorName,'SCENARIO_EXPECTED_REVERT_NOT_OBSERVED');
    await record({kind:'read-only-revert',label,errorName,transactionSent:false});
  }
  return { ethers,provider,signers,owners,accounts,account,projection,controller,payments,projectionAddress,controllerAddress,
    domain,conditionHash,hash,uid,transaction,open,state,consent,forward,admit,complete,beginReturn,hop,payout,refused,record };
}

async function runCoreJourney(k,{funded}) {
  const {projection,controller,payments}=k;
  const s=await k.open();
  await k.forward(s,0,1,{funded}); await k.forward(s,1,2,{funded}); await k.forward(s,2,3,{funded});
  assert.equal(await projection.ownerOf(s.tokenId),k.accounts[3]);
  assert.equal(await projection.holderAsOf(s.tokenId,BigInt((await k.provider.getBlock('latest')).timestamp)),k.accounts[0]);
  await k.refused('owner-only-cannot-complete',async()=>controller.completeThrough.staticCall(s.id,s.legs[0],(await k.state(s)).revision),controller,'CompletionEvidenceUnavailable');
  await k.refused('active-account-cannot-withdraw',()=>k.account(3).withdrawStandalone.staticCall(k.projectionAddress,s.tokenId,k.owners[3]),k.account(3),'ProtectedAsset');
  if (funded) await k.refused('unresolved-tail-cannot-allocate',()=>payments.allocate.staticCall(s.id,s.legs[2]),payments,'OutcomeUnavailable');
  await k.admit(s,1); await k.complete(s,1);
  const now=BigInt((await k.provider.getBlock('latest')).timestamp);
  assert.equal(await projection.isFinalAsOf(s.tokenId,now),false,'COMMERCIAL_COMPLETION_IS_NOT_TEMPORAL_FINALITY');
  if (funded) await k.payout(s,0,0,4n);
  await k.beginReturn(s,2);
  if (funded) await k.refused('request-without-return-cannot-refund',()=>payments.allocate.staticCall(s.id,s.legs[2]),payments,'OutcomeUnavailable');
  const beforeHop=await k.state(s);
  await k.hop(s);
  if (funded) await k.payout(s,2,3,5n);
  await k.refused('duplicate-hop-revision',()=>controller.connect(k.signers[4]).returnHop.staticCall(s.id,s.legs[2],beforeHop.revision),controller,'RevisionMismatch');
  await k.hop(s); if (funded) await k.payout(s,1,2,5n);
  assert.equal(await projection.ownerOf(s.tokenId),k.accounts[1]);
  // Leg 0 completed and left the chain: its record is not readable here, only
  // the fact that it ended and the commitment that now covers it.
  await k.refused('detached-leg-not-on-chain',()=>controller.legAt.staticCall(s.id,0),controller,'LegAtRegister');
  assert.equal(await controller.legTerminalOutcome(s.id,s.legs[0]),1n);
  const gone=await controller.detached(s.id);
  assert.equal(gone.count,1n); assert.notEqual(gone.commitment,'0x'+'00'.repeat(32));
  assert.equal((await k.state(s)).completedCount,1n);
  await k.refused('detached-head-cannot-return',async()=>controller.connect(k.signers[4]).beginReturn.staticCall(s.id,s.legs[0],k.conditionHash,k.uid('evidence'),(await k.state(s)).revision),controller,'ReturnBoundaryRefused');
  await k.admit(s,3);
  assert.equal((await controller.legAt(s.id,2)).outcome,3n,'LATE_ADMISSION_REWROTE_RETURN');
  await k.transaction('close-resolved-sequence',controller.connect(k.signers[1]).closeSequence(s.id,(await k.state(s)).revision));
  await k.transaction('standalone-after-close',k.account(1).withdrawStandalone(k.projectionAddress,s.tokenId,k.owners[1]));
  assert.equal(await projection.ownerOf(s.tokenId),k.owners[1]);
  if (funded) assert.equal(await k.provider.getBalance(await payments.getAddress()),0n,'SCENARIO_PAYMENT_RESIDUE');
  await k.record({kind:'journey',name:funded?'funded-prefix-detach-tail-return':'escrow-free-prefix-detach-tail-return',
    sequenceId:s.id,tokenId:s.tokenId.toString(),assertionsCompleted:true,uiVerified:false,securityAuditPassed:false});
  return s;
}
async function runExtendedJourneys(k) {
  const c=k.controller,p=k.projection;
  // Real open gap is normal lag; it never blocks an accepted token forward.
  const lag=await k.open(),gap=k.uid('lag-gap');
  const now=BigInt((await k.provider.getBlock('latest')).timestamp);
  await k.transaction('begin-lag-gap',p.connect(k.signers[4]).beginSettlement(lag.tokenId,gap,k.accounts[1],k.uid('snapshot'),now+3600n));
  await k.forward(lag,0,1);await k.forward(lag,1,2);await k.forward(lag,2,3);
  assert.equal(await p.openGapOf(lag.tokenId),gap);assert.equal(await p.ownerOf(lag.tokenId),k.accounts[3]);
  assert.equal((await k.state(lag)).callbackRootPlusOne,0n);
  await k.beginReturn(lag,1);for(let i=0;i<3;i++)await k.hop(lag);
  assert.equal(await p.ownerOf(lag.tokenId),k.accounts[0]);
  await k.record({kind:'journey',name:'lag-does-not-block-forward-unresolved-root-return',sequenceId:lag.id,assertionsCompleted:true});
  const funded=await k.open();for(let i=0;i<3;i++)await k.forward(funded,i,i+1,{funded:true});
  await k.beginReturn(funded,1);for(let i=2;i>=0;i--){await k.hop(funded);await k.payout(funded,i,i+1,5n);}
  assert.equal(await p.ownerOf(funded.tokenId),k.accounts[0]);
  await k.record({kind:'journey',name:'full-original-route-refunds',sequenceId:funded.id,assertionsCompleted:true});
  const ahead=await k.open();await k.forward(ahead,0,1);await k.forward(ahead,1,2);await k.admit(ahead,2);
  const stale=await k.consent(ahead,2,3);await k.complete(ahead,1);
  await k.refused('tail-concurrency-stale',()=>c.connect(k.signers[2]).forward.staticCall(stale.c,stale.signature),c,'RevisionMismatch');
  await k.forward(ahead,2,3);await k.complete(ahead,2);
  assert.equal(await c.legCount(ahead.id),3n);assert.equal((await c.legAt(ahead.id,2)).outcome,0n);
  await k.record({kind:'journey',name:'holder-ahead-and-tail-extension',sequenceId:ahead.id,assertionsCompleted:true});
  const repeat=await k.open();await k.forward(repeat,0,1);await k.forward(repeat,1,0);await k.forward(repeat,0,2);
  await k.admit(repeat,2);await k.complete(repeat,2);
  await k.refused('repeat-address-rebind',async()=>c.connect(k.signers[4]).bindAdmission.staticCall(repeat.id,0,2,(await k.state(repeat)).revision),c,'AdmissionBindingImmutable');
  await k.record({kind:'journey',name:'repeated-address-distinct-occurrences',sequenceId:repeat.id,assertionsCompleted:true});
  const race=await k.open();await k.forward(race,0,1);await k.admit(race,1);const revision=(await k.state(race)).revision;
  await k.beginReturn(race,1);
  await k.refused('callback-wins-old-revision',()=>c.completeThrough.staticCall(race.id,race.legs[0],revision),c,'RevisionMismatch');
  await k.refused('callback-wins-current-revision',async()=>c.completeThrough.staticCall(race.id,race.legs[0],(await k.state(race)).revision),c,'CallbackActive');
  await k.hop(race);
  await k.record({kind:'journey',name:'callback-completion-serialization',sequenceId:race.id,assertionsCompleted:true});
}
module.exports={createScenario,runCoreJourney,runExtendedJourneys,FORWARD_FIELDS};
