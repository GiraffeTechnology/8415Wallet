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

describe('ProjectionEscrow', function () {
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

  /** The key a seller's own identifier is stored under. */
  const keyOf = (opener, localId) =>
    ethers.keccak256(coder.encode(['address', 'bytes32'], [opener, localId]));

  let TRADE;

  const openTrade = async (options = {}) => {
    TRADE = keyOf(seller.address, LOCAL);
    await projection.connect(seller).approve(await escrow.getAddress(), TOKEN);
    return escrow.connect(seller).open(
      LOCAL,
      await projection.getAddress(),
      TOKEN,
      buyer.address,
      PRICE,
      options.admissionDeadline ?? now + 86_400n,
      options.maxEffectiveAt ?? now + 86_400n
    );
  };

  const fund = () => escrow.connect(buyer).fund(TRADE, { value: PRICE });

  const rejects = async (promise, name) => {
    const selector = escrow.interface.getError(name).selector.toLowerCase().slice(2);
    try {
      await promise;
      assert.fail(`expected ${name}`);
    } catch (error) {
      assert.ok(
        JSON.stringify(error).toLowerCase().includes(selector),
        `expected ${name}, got ${error.message}`
      );
    }
  };

  const warpPast = async (instant) => {
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(instant) + 1]);
    await ethers.provider.send('evm_mine', []);
  };

  it('holds both sides until the register confirms the buyer, then settles', async () => {
    await openTrade();
    assert.equal(await projection.ownerOf(TOKEN), await escrow.getAddress());
    await fund();

    // Not yet: the position is escrowed but the register still names the seller.
    await rejects(escrow.release(TRADE), 'NotConfirmed');
    assert.equal((await projection.currentEntry(TOKEN)).holder, seller.address);

    await admit();

    const sellerBefore = await ethers.provider.getBalance(seller.address);
    await escrow.connect(stranger).release(TRADE);

    assert.equal(await projection.ownerOf(TOKEN), buyer.address);
    assert.equal((await projection.currentEntry(TOKEN)).holder, buyer.address);
    assert.equal(await ethers.provider.getBalance(seller.address) - sellerBefore, PRICE);
    assert.equal(await ethers.provider.getBalance(await escrow.getAddress()), 0n);
  });

  it('releases on a confirmation that is admitted but not final', async () => {
    // The point of the whole design. An instant is final only once a LATER
    // entry exists, so the admitting entry's own effective time is never final
    // when it lands. An escrow that waited for finality here would wait for an
    // unrelated future admission, and could wait forever.
    await openTrade();
    await fund();
    await admit();

    const entry = await projection.currentEntry(TOKEN);
    assert.equal(await projection.isFinalAsOf(TOKEN, entry.effectiveAt), false);

    await escrow.release(TRADE);
    assert.equal(await projection.ownerOf(TOKEN), buyer.address);
  });

  it('refuses to release on an admission naming someone else', async () => {
    await openTrade();
    await fund();
    await admit({ holder: stranger.address });

    assert.equal((await projection.currentEntry(TOKEN)).holder, stranger.address);
    await rejects(escrow.release(TRADE), 'NotConfirmed');
  });

  it('refuses an effective time beyond what the parties agreed', async () => {
    // A confirmation dated far enough out is not the confirmation anyone
    // traded for, and because effective times strictly increase it would end
    // the projection for this token permanently.
    await openTrade({ maxEffectiveAt: now + 600n });
    await fund();
    await admit({ effectiveAt: now + 5000n });

    assert.equal((await projection.currentEntry(TOKEN)).holder, buyer.address);
    await rejects(escrow.release(TRADE), 'NotConfirmed');
  });

  it('will not release on a confirmation that already stood before the trade', async () => {
    // The buyer is confirmed first, then the trade is funded. Without the
    // version guard the escrow would release immediately on a record that
    // owes nothing to this trade.
    await admit();
    assert.equal((await projection.currentEntry(TOKEN)).holder, buyer.address);

    await openTrade();
    await fund();
    await rejects(escrow.release(TRADE), 'NotConfirmed');
  });

  it('returns both sides when the deadline passes with nothing admitted', async () => {
    const deadline = now + 3600n;
    await openTrade({ admissionDeadline: deadline });
    await fund();

    await rejects(escrow.refund(TRADE), 'DeadlineNotPassed');
    await warpPast(deadline);

    const buyerBefore = await ethers.provider.getBalance(buyer.address);
    await escrow.connect(stranger).refund(TRADE);

    assert.equal(await projection.ownerOf(TOKEN), seller.address);
    assert.equal(await ethers.provider.getBalance(buyer.address) - buyerBefore, PRICE);
  });

  it('refunds a gap that was cancelled, and one that was never opened alike', async () => {
    // The reference pattern is usually written as "refund if the gap is
    // cancelled without admission". Keyed on cancellation alone, an escrow
    // hangs when the gap is superseded, expires while open, or is never opened.
    // The condition here is the complement of release against a deadline, so
    // all of those resolve.
    const deadline = now + 3600n;
    await openTrade({ admissionDeadline: deadline });
    await fund();

    const gapDeadline = BigInt((await ethers.provider.getBlock('latest')).timestamp) + 600n;
    await projection.connect(registrar).beginSettlement(TOKEN, GAP, buyer.address, SNAPSHOT, gapDeadline);
    await warpPast(gapDeadline);
    await projection.connect(registrar).cancelSettlement(GAP, b32('reason'));

    // A cancellation settles nothing and is not a rejection, so it does not by
    // itself release the escrow — the deadline does.
    assert.equal((await projection.settlement(GAP)).status, 3n);
    await warpPast(deadline);
    await escrow.refund(TRADE);
    assert.equal(await projection.ownerOf(TOKEN), seller.address);
  });

  it('will not claw back an asset the register has confirmed, even past the deadline', async () => {
    const deadline = now + 3600n;
    await openTrade({ admissionDeadline: deadline });
    await fund();
    await admit();
    await warpPast(deadline);

    await rejects(escrow.refund(TRADE), 'AlreadyConfirmed');
    await escrow.release(TRADE);
    assert.equal(await projection.ownerOf(TOKEN), buyer.address);
  });

  it('refuses to escrow against anything that does not advertise the projection', async () => {
    // Three ways to not be a projection, one answer. A contract with no
    // supportsInterface reverts when asked; an address with no code answers
    // nothing at all; neither is a failure the caller should have to decode.
    const impostor = await (await ethers.getContractFactory('ProjectionEscrow')).deploy();
    await impostor.waitForDeployment();
    for (const target of [await impostor.getAddress(), stranger.address]) {
      await rejects(
        escrow.connect(seller).open(
          b32(`trade-${target}`), target, TOKEN, buyer.address, PRICE, now + 86_400n, now + 86_400n
        ),
        'NotAProjection'
      );
    }
  });

  it('one deployment is shared, and no venue can squat another party\'s identifier', async () => {
    // The whole point of a single escrow behind many venues. A caller-chosen
    // identifier in one flat namespace would let anyone take the next id a
    // venue was about to use and make its open revert. Keys are namespaced by
    // the opener, so the same local identifier from two parties is two trades
    // and neither can write into the other's space.
    await openTrade();

    const [, , , , , otherSeller] = await ethers.getSigners();
    await projection.mint(otherSeller.address, 99n, b32('other-v1'), REF1, e1);
    await projection.connect(otherSeller).approve(await escrow.getAddress(), 99n);
    await escrow.connect(otherSeller).open(
      LOCAL, await projection.getAddress(), 99n, buyer.address, PRICE, now + 86_400n, now + 86_400n
    );

    const mine = keyOf(seller.address, LOCAL);
    const theirs = keyOf(otherSeller.address, LOCAL);
    assert.notEqual(mine, theirs);
    // The contract's own derivation, against the one an integrator computes
    // off chain. A venue that got this wrong would display one trade and
    // settle another.
    assert.equal(await escrow.keyFor(seller.address, LOCAL), mine);
    assert.equal(await escrow.keyFor(otherSeller.address, LOCAL), theirs);
    assert.equal((await escrow.tradeOf(mine)).tokenId, TOKEN);
    assert.equal((await escrow.tradeOf(theirs)).tokenId, 99n);
    assert.equal((await escrow.tradeOf(mine)).seller, seller.address);
    assert.equal((await escrow.tradeOf(theirs)).seller, otherSeller.address);
  });

  it('lets the seller take the asset back before payment, and not after', async () => {
    await openTrade();
    await escrow.connect(seller).abandon(TRADE);
    assert.equal(await projection.ownerOf(TOKEN), seller.address);

    // A fresh identifier: an abandoned trade stays on the record rather than
    // freeing its id for reuse.
    const secondLocal = b32('trade-2');
    const second = keyOf(seller.address, secondLocal);
    await projection.connect(seller).approve(await escrow.getAddress(), TOKEN);
    await escrow.connect(seller).open(
      secondLocal, await projection.getAddress(), TOKEN, buyer.address, PRICE, now + 86_400n, now + 86_400n
    );
    await escrow.connect(buyer).fund(second, { value: PRICE });
    await rejects(escrow.connect(seller).abandon(second), 'WrongState');
  });

  it('a trade identifier cannot be reused by its own opener once it exists', async () => {
    await openTrade();
    await escrow.connect(seller).abandon(TRADE);
    await projection.connect(seller).approve(await escrow.getAddress(), TOKEN);
    await rejects(openTrade(), 'AlreadyExists');
  });

  it('reports the position and the confirmed holder as two facts', async () => {
    await openTrade();
    await fund();

    let view = await escrow.observe(TRADE);
    assert.equal(view.confirmed, false);
    assert.equal(view.confirmedHolder, seller.address);
    assert.equal(view.positionHolder, await escrow.getAddress());
    assert.equal(view.entryCount, 1n);

    await admit();
    view = await escrow.observe(TRADE);
    assert.equal(view.confirmed, true);
    assert.equal(view.confirmedHolder, buyer.address);
    // Still the escrow's: release has not run, so the two have not converged.
    assert.equal(view.positionHolder, await escrow.getAddress());
    assert.equal(view.version, 2n);
  });

  it('only the named buyer can fund, and only in full', async () => {
    await openTrade();
    await rejects(escrow.connect(stranger).fund(TRADE, { value: PRICE }), 'NotParty');
    await rejects(escrow.connect(buyer).fund(TRADE, { value: PRICE - 1n }), 'WrongPayment');
    await fund();
    await rejects(fund(), 'WrongState');
  });
});
