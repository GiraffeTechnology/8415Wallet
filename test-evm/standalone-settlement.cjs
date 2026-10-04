const assert = require('node:assert/strict');
const hre = require('hardhat');
const { requestLocalEip1193 } = require('../scripts/controls/local-eip1193.cjs');
const { ethers } = hre;
const hash = text => ethers.keccak256(ethers.toUtf8Bytes(text));
const coder = ethers.AbiCoder.defaultAbiCoder();

// Actual reference contract and SDK/signer. Local EVM only, with a deterministic
// selected-account provider and public-hash memory CAS, not wallet UI acceptance.
describe('Standalone settlement SDK without a responsibility controller', function () {
  this.timeout(120000);
  let sdk, registrar, buyer, projection, validators, pin, registerId, initial, reference, snapshot, now;
  before(async () => { sdk = await import('../src/wallet/standaloneSettlement.ts'); });
  beforeEach(async () => {
    [, registrar, buyer] = await ethers.getSigners();
    validators = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    registerId = hash('standalone-register'); initial = hash('initial'); reference = hash('initial-reference'); snapshot = hash('snapshot');
    projection = await (await ethers.getContractFactory('RegisterProjectionReference')).deploy(registerId, registrar.address, validators.map(v => v.address), 2);
    await projection.waitForDeployment(); now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    await projection.mint(registrar.address, 1n, initial, reference, now - 100n);
    pin = { chainId: (await ethers.provider.getNetwork()).chainId, controller: (await projection.getAddress()).toLowerCase(),
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(await projection.getAddress())) };
  });
  function session(actor = registrar.address) {
    let state = null, sends = 0;
    const provider = { request: async ({ method, params = [] }) => {
      if (method === 'eth_accounts') return [actor];
      if (method === 'eth_sendTransaction') sends++;
      return requestLocalEip1193(hre.network.provider, { method, params });
    } };
    const store = { read: async () => structuredClone(state), compareAndSwap: async (expected, next) => {
      if ((state?.revision ?? null) !== expected) return false;
      state = sdk.parseSettlementState(sdk.serializeSettlementState(next)); return true;
    } };
    const create = () => new sdk.StandaloneSettlementSession(provider, pin, actor, store);
    return { wallet: create(), create, sends: () => sends, state: () => state };
  }
  async function send(f, intent) {
    const review = await f.wallet.prepare(intent); const before = f.sends();
    const tx = await f.wallet.submit(review, review.digest); assert.equal(f.sends(), before + 1);
    const receipt = await f.wallet.reconcile(1n); assert.equal(receipt.state, 'confirmed');
    assert.equal(receipt.executionEventObserved, true); assert.equal(receipt.protocolFinality, 'not-evaluated');
    await f.wallet.acknowledge(1n); return tx;
  }
  function begin(id, deadline = now + 600n) { return { kind: 'beginSettlement', params: { tokenId: 1n, settlementId: id,
    expectedHolder: buyer.address.toLowerCase(), snapshotHash: snapshot, deadline } }; }
  it('opens a gap, relays a real reference proof, and preserves raw provisional finality', async () => {
    const f = session(), id = hash('real-settlement'), commitment = hash('admitted'), ref = hash('reference'), effectiveAt = now - 10n;
    await send(f, begin(id)); assert.equal(await projection.openGapOf(1n), id);
    assert.equal((await projection.currentEntry(1n)).recordCommitment, initial);
    const leafType = hash('RemoteEntry(uint256 localChainId,address localContract,uint256 tokenId,bytes32 settlementId,address holder,bytes32 snapshotHash,bytes32 previousCommitment,bytes32 recordCommitment,bytes32 registryReference,uint64 version,uint64 effectiveAt)');
    const finalityType = hash('RemoteFinality(bytes32 remoteRegisterId,uint64 remoteHeight,bytes32 remoteBlockHash,bytes32 remoteStateRoot,bytes32 validatorSetHash)');
    const leaf = ethers.keccak256(coder.encode(['bytes32','uint256','address','uint256','bytes32','address','bytes32','bytes32','bytes32','bytes32','uint64','uint64'],
      [leafType,pin.chainId,pin.controller,1n,id,buyer.address,snapshot,initial,commitment,ref,2n,effectiveAt]));
    const root = ethers.keccak256(ethers.concat(['0x00',leaf])), remoteBlock = hash('remote-block');
    const setHash = ethers.keccak256(coder.encode(['address[]','uint8'],[validators.map(v=>v.address),2]));
    const structure = ethers.keccak256(coder.encode(['bytes32','bytes32','uint64','bytes32','bytes32','bytes32'],[finalityType,registerId,1n,remoteBlock,root,setHash]));
    const digest = ethers.keccak256(ethers.concat(['0x1901',await projection.DOMAIN_SEPARATOR(),structure]));
    const proofData = coder.encode(['uint64','bytes32','bytes32','uint256','bytes32[]','bytes[]'],[1n,remoteBlock,root,0n,[],validators.map(v=>ethers.Signature.from(v.signingKey.sign(digest)).serialized)]);
    // Proof relay does not require settlement authority. The SDK checks open-gap
    // semantics and the reference contract validates the actual proof.
    await send(session(buyer.address), { kind: 'finalizeSettlement', params: { settlementId: id, recordCommitment: commitment,
      registryReference: ref, effectiveAt, proofData } });
    assert.equal((await projection.currentEntry(1n)).holder,buyer.address); assert.equal(await projection.ownerOf(1n),registrar.address);
    assert.equal(await projection.isFinalAsOf(1n,effectiveAt),false); assert.equal(await projection.openGapOf(1n),ethers.ZeroHash);
  });
  it('refuses unauthorized begin and premature cancel, then cancels without admission', async () => {
    const id = hash('cancel-gap'), deadline = now + 60n;
    await assert.rejects(session(buyer.address).wallet.prepare(begin(id,deadline)), /settlement authority/);
    const f = session(); await send(f, begin(id,deadline)); const count = await projection.entryCount(1n);
    const cancel = { kind: 'cancelSettlement', params: { settlementId: id, reasonHash: hash('cancel-reason') } };
    await assert.rejects(f.wallet.prepare(cancel), /deadline has passed/);
    await hre.network.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(deadline+1n)]});
    await hre.network.provider.request({method:'evm_mine',params:[]}); await send(f,cancel);
    assert.equal(await projection.entryCount(1n),count); assert.equal(await projection.openGapOf(1n),ethers.ZeroHash);
    assert.equal(await projection.isFinalAsOf(1n,deadline+1n),false);
  });
  it('restarts after a submitted transaction and refuses any automatic duplicate send', async () => {
    const f = session(), intent = begin(hash('restart-gap')); const review = await f.wallet.prepare(intent);
    await f.wallet.submit(review,review.digest); const restarted = f.create();
    await assert.rejects(restarted.prepare(intent),/SETTLEMENT_RECONCILIATION_REQUIRED/);
    assert.equal((await restarted.reconcile(1n)).state,'confirmed'); assert.equal(f.sends(),1);
    await restarted.acknowledge(1n); assert.equal((await restarted.status()).status,'idle'); assert.equal(f.sends(),1);
  });
});
