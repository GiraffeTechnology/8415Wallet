const assert = require('node:assert/strict');
const hre = require('hardhat');
const { ethers } = hre;

/**
 * The escrow, exercised against the ERC-8415 reference implementation.
 *
 * Not against a mock. A mock of the projection would be written by the same
 * hand as the escrow that reads it, so the two could agree on a misreading of
 * the standard and this suite would pass. The register here is the reference
 * contract from the ERC repository, admitting entries through its real
 * settlement path with real validator signatures over the real proof shape.
 */

const b32 = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
const coder = ethers.AbiCoder.defaultAbiCoder();

const LEAF_TYPE = b32(
  'RemoteEntry(uint256 localChainId,address localContract,uint256 tokenId,bytes32 settlementId,address holder,bytes32 snapshotHash,bytes32 previousCommitment,bytes32 recordCommitment,bytes32 registryReference,uint64 version,uint64 effectiveAt)'
);
const FINALITY_TYPE = b32(
  'RemoteFinality(bytes32 remoteRegisterId,uint64 remoteHeight,bytes32 remoteBlockHash,bytes32 remoteStateRoot,bytes32 validatorSetHash)'
);

const REGISTER_ID = b32('register-1');
const TOKEN = 42n;
const C1 = b32('commitment-v1');
const C2 = b32('commitment-v2');
const REF1 = b32('reference-v1');
const REF2 = b32('reference-v2');
const SNAPSHOT = b32('snapshot-1');
const GAP = b32('settlement-1');
const LOCAL = b32('trade-1');
const PRICE = ethers.parseEther('3');

describe('Legacy clearing SDK against actual local EVM', function () {
  this.timeout(180000);
  let sdk, deployment;
  before(async () => { sdk = await import('../src/wallet/legacyClearingSession.ts'); });
  let projection, escrow, admin, seller, buyer, stranger, registrar, validators, setHash, domain;
  let now, e1, remoteHeight;

  beforeEach(async () => {
    [admin, seller, buyer, stranger, registrar] = await ethers.getSigners();

    validators = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
      .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    const addresses = validators.map((v) => v.address);
    setHash = ethers.keccak256(coder.encode(['address[]', 'uint8'], [addresses, 2]));

    const Projection = await ethers.getContractFactory('RegisterProjectionReference');
    projection = await Projection.deploy(REGISTER_ID, registrar.address, addresses, 2);
    await projection.waitForDeployment();

    const Escrow = await ethers.getContractFactory('ProjectionEscrow');
    escrow = await Escrow.deploy();
    await escrow.waitForDeployment();

    now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    e1 = now - 7200n;
    remoteHeight = 10n;
    await projection.mint(seller.address, TOKEN, C1, REF1, e1);
    domain = await projection.DOMAIN_SEPARATOR();
    const pin = async contract => ({ address: (await contract.getAddress()).toLowerCase(), runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(await contract.getAddress())) });
    deployment = { schema: '8415-legacy-clearing/1', chainId: (await ethers.provider.getNetwork()).chainId.toString(),
      escrow: await pin(escrow), projection: await pin(projection), registerId: REGISTER_ID, verificationProfile: await projection.verificationProfile() };
  });

  /** Build the proof the reference implementation verifies. */
  async function proof(options = {}) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const v = {
      holder: options.holder ?? buyer.address,
      previous: options.previous ?? C1,
      commitment: options.commitment ?? C2,
      reference: options.reference ?? REF2,
      version: options.version ?? 2n,
      effectiveAt: options.effectiveAt ?? now - 60n,
      settlementId: options.settlementId ?? GAP,
    };
    const leafStruct = ethers.keccak256(coder.encode(
      ['bytes32', 'uint256', 'address', 'uint256', 'bytes32', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'],
      [LEAF_TYPE, chainId, await projection.getAddress(), TOKEN, v.settlementId, v.holder, SNAPSHOT,
        v.previous, v.commitment, v.reference, v.version, v.effectiveAt]
    ));
    const root = ethers.keccak256(ethers.concat(['0x00', leafStruct]));
    const height = options.height ?? remoteHeight;
    const blockHash = b32(`remote-block-${height}`);
    const structHash = ethers.keccak256(coder.encode(
      ['bytes32', 'bytes32', 'uint64', 'bytes32', 'bytes32', 'bytes32'],
      [FINALITY_TYPE, REGISTER_ID, height, blockHash, root, setHash]
    ));
    const digest = ethers.keccak256(ethers.concat(['0x1901', domain, structHash]));
    const signatures = validators.slice(0, 2)
      .map((w) => ethers.Signature.from(w.signingKey.sign(digest)).serialized);
    return coder.encode(
      ['uint64', 'bytes32', 'bytes32', 'uint256', 'bytes32[]', 'bytes[]'],
      [height, blockHash, root, 0n, [], signatures]
    );
  }

  /** Open a gap and admit an entry through it: one full register movement. */
  async function admit(options = {}) {
    const id = options.settlementId ?? GAP;
    const holder = options.holder ?? buyer.address;
    const effectiveAt = options.effectiveAt ?? now - 60n;
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp) + 3600n;
    await projection.connect(registrar).beginSettlement(TOKEN, id, holder, SNAPSHOT, deadline);
    const data = await proof({ ...options, settlementId: id, holder, effectiveAt });
    await projection.finalizeSettlement(
      id,
      options.commitment ?? C2,
      options.reference ?? REF2,
      effectiveAt,
      data
    );
  }


  function session(actor, hooks = {}) {
    let state = null;
    const provider = { request: async ({ method, params = [] }) => {
      if (method === 'eth_accounts') return [actor.address];
      if (method === 'eth_sendTransaction' && hooks.send) return hooks.send(params);
      return hre.network.provider.request({ method, params });
    } };
    const store = { read: async () => structuredClone(state), compareAndSwap: async (expected, next) => {
      if ((state?.revision ?? null) !== expected) return false;
      state = sdk.parseLegacyClearingState(JSON.stringify(next)); return true;
    } };
    return new sdk.LegacyClearingSession(provider, deployment, actor.address, store);
  }
  const request = (kind) => JSON.stringify({ kind, localId: LOCAL, tokenId: TOKEN.toString(), buyer: buyer.address,
    priceWei: PRICE.toString(), admissionDeadline: (now + 3600n).toString(), maxEffectiveAt: (now + 3600n).toString() });
  const existing = (kind) => JSON.stringify({ kind, tradeKey: sdk.legacyTradeKey(seller.address, LOCAL) });
  async function execute(wallet, input) {
    const review = await wallet.prepare(input), hash = await wallet.submit(review, review.digest);
    await hre.network.provider.request({ method: 'evm_mine', params: [] });
    assert.equal((await wallet.reconcile()).state, 'confirmed'); await wallet.acknowledge();
    assert.equal((await wallet.status()).status, 'idle'); return hash;
  }
  async function openThroughWallet() {
    const wallet = session(seller); await wallet.verify();
    await assert.rejects(wallet.prepare(request('open')), /CLEARING_TOKEN_APPROVAL_REQUIRED/);
    await execute(wallet, request('approve')); assert.equal(await projection.getApproved(TOKEN), await escrow.getAddress());
    await execute(wallet, request('open')); assert.equal(await projection.ownerOf(TOKEN), await escrow.getAddress()); return wallet;
  }
  it('approves, opens, funds, reads divergent records and releases using exact SDK ABI and canonical events', async () => {
    const sellerWallet = await openThroughWallet(); await execute(session(buyer), existing('fund'));
    const read = await sellerWallet.observe(sdk.legacyTradeKey(seller.address, LOCAL));
    assert.equal(read.trade.state, 'FUNDED'); assert.equal(read.observation.positionHolder, deployment.escrow.address);
    assert.equal(read.observation.confirmedHolder, seller.address.toLowerCase());
    await assert.rejects(session(stranger).prepare(existing('release')), /CLEARING_RELEASE_UNAVAILABLE/);
    await admit(); await execute(session(stranger), existing('release'));
    assert.equal(await projection.ownerOf(TOKEN), buyer.address);
    assert.equal(await projection.isFinalAsOf(TOKEN, now - 60n), false);
    assert.equal((await sellerWallet.observe(sdk.legacyTradeKey(seller.address, LOCAL))).view.state, 'released');
  });
  it('refunds both sides after the agreed deadline without requiring a cancelled gap', async () => {
    await openThroughWallet(); await execute(session(buyer), existing('fund'));
    await assert.rejects(session(stranger).prepare(existing('refund')), /CLEARING_REFUND_UNAVAILABLE/);
    await hre.network.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(now + 3601n)] });
    await hre.network.provider.request({ method: 'evm_mine', params: [] });
    assert.equal(await projection.openGapOf(TOKEN), ethers.ZeroHash);
    await execute(session(stranger), existing('refund'));
    assert.equal(await projection.ownerOf(TOKEN), seller.address); assert.equal(await ethers.provider.getBalance(await escrow.getAddress()), 0n);
  });
  it('withdraws an unfunded trade as seller and refuses a buyer withdrawal', async () => {
    const wallet = await openThroughWallet(); await assert.rejects(session(buyer).prepare(existing('abandon')), /CLEARING_SELLER_OR_STATE_REFUSED/);
    await execute(wallet, existing('abandon')); assert.equal(await projection.ownerOf(TOKEN), seller.address);
  });
  it('recovers a canonical same-nonce wallet cancellation without retrying or calling the original action successful', async () => {
    await projection.connect(seller).approve(await escrow.getAddress(), TOKEN);
    let cancellationHash, sends = 0;
    const wallet = session(seller, { send: async params => {
      sends++;
      cancellationHash = await hre.network.provider.request({ method: 'eth_sendTransaction', params: [{ from: seller.address, to: seller.address, nonce: params[0].nonce, value: '0x0', data: '0x' }] });
      throw new Error('original outcome unknown');
    } });
    const review = await wallet.prepare(request('open'));
    await assert.rejects(wallet.submit(review, review.digest), /OUTCOME_UNCERTAIN/);
    await hre.network.provider.request({ method: 'evm_mine', params: [] });
    const recovery = await wallet.acknowledgeReplacement(cancellationHash);
    assert.equal(recovery.originalOutcome, 'superseded-not-successful'); assert.equal((await wallet.status()).status, 'idle');
    assert.equal(sends, 1); assert.equal(await projection.ownerOf(TOKEN), seller.address);
  });
});
