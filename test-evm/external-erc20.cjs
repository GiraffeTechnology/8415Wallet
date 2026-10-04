const assert = require('node:assert/strict');
const hre = require('hardhat');
const { ethers } = require('ethers');
const { createProvider } = require('hardhat/internal/core/providers/construction');
const { requestLocalEip1193 } = require('../scripts/controls/local-eip1193.cjs');

// Local EVM evidence only: real contracts, calldata, balances and receipts with
// the actual SDK. This is neither a public-Sepolia run nor wallet UI acceptance.
// An isolated in-memory chain uses the real supported chain ID 11155111; no RPC
// identity or receipt fields are rewritten and the rest of the suite is intact.
describe('External ERC-20 SDK sessions on a real local EVM', function () {
  this.timeout(120000);
  const chainId = '11155111';
  const Return = { True: 0, Empty: 1, False: 2, Short: 3, InvalidBool: 4, TrailingData: 5, Revert: 6 };
  const Metadata = { Present: 0, Absent: 1, Malformed: 2 };
  const Effect = { Exact: 0, Fee: 1, WrongFrom: 2, WrongTo: 3, IndexedAmount: 4, ExtraData: 5, Missing: 6, OtherContract: 7 };
  let sdk, local, rpc, actor, recipient, outsider, signer, factory, snapshot;

  before(async () => {
    sdk = await import('../src/xiongan/externalAssets.ts');
    local = await createProvider({ ...hre.config, networks: { ...hre.config.networks,
      hardhat: { ...hre.config.networks.hardhat, chainId: Number(chainId), forking: undefined,
        mining: { ...hre.config.networks.hardhat.mining, auto: true, interval: 0 } } } }, 'hardhat', hre.artifacts);
    assert.equal(await local.request({ method: 'eth_chainId', params: [] }), '0xaa36a7');
    rpc = new ethers.BrowserProvider(local, undefined, { cacheTimeout: -1 });
    [actor, recipient, outsider] = (await local.request({ method: 'eth_accounts', params: [] })).map(a => a.toLowerCase());
    signer = await rpc.getSigner(actor);
    const artifact = await hre.artifacts.readArtifact('ExternalERC20Fixture');
    factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
    snapshot = await local.request({ method: 'evm_snapshot', params: [] });
  });
  beforeEach(async () => {
    assert.equal(await local.request({ method: 'evm_revert', params: [snapshot] }), true);
    snapshot = await local.request({ method: 'evm_snapshot', params: [] });
  });
  after(() => { rpc?.destroy(); });

  async function deploy(returnMode = Return.True, metadataMode = Metadata.Present, effectMode = Effect.Exact) {
    const token = await factory.deploy(actor, returnMode, metadataMode, effectMode);
    await token.waitForDeployment();
    return token;
  }
  async function request(token, amount = '1234567', changes = {}) {
    const header = await local.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    return JSON.stringify({ schema: 'xiongan-asset-request/1', requestId: 'local-erc20-1', agent: 'Local test',
      chainId, actor, expiresAt: (BigInt(header.timestamp) + 600n).toString(),
      action: { kind: 'erc20-transfer', contract: (await token.getAddress()).toLowerCase(), recipient, amount, ...changes } });
  }
  function session(options = {}) {
    let record = null, sends = 0, minedHash = null;
    const methods = [], calls = [];
    const provider = { request: async ({ method, params = [] }) => {
      methods.push(method);
      if (method === 'eth_accounts') return [actor];
      if (method === 'eth_call') calls.push(structuredClone(params[0]));
      if (method === 'eth_sendTransaction') {
        sends++;
        if (options.reject) throw Object.assign(new Error('Owner declined the local test prompt'), { code: 4001 });
        minedHash = await requestLocalEip1193(local, { method, params });
        if (options.loseResponse) throw new Error('Injected response loss after local mining');
        return minedHash;
      }
      return requestLocalEip1193(local, { method, params });
    } };
    const store = { read: async () => structuredClone(record), compareAndSwap: async (expected, next) => {
      if ((record?.revision ?? null) !== expected) return false;
      record = sdk.parseAssetState(JSON.stringify(next));
      return true;
    } };
    const create = () => new sdk.ExternalAssetSession(provider, chainId, actor, store);
    return { wallet: create(), create, sends: () => sends, minedHash: () => minedHash, methods, calls, options };
  }
  async function submit(f, token, amount) {
    const review = await f.wallet.prepare(await request(token, amount));
    assert.equal(f.sends(), 0);
    const hash = await f.wallet.submit(review, review.digest);
    assert.equal(f.sends(), 1);
    return { review, hash };
  }

  it('reads six-decimal balances and executes exactly transfer(address,uint256) without ERC-165 or approvals', async () => {
    const token = await deploy(), f = session(), address = (await token.getAddress()).toLowerCase();
    const balance = await f.wallet.erc20Balance(address);
    assert.equal(balance.balanceRaw, '10000000');
    assert.deepEqual(balance.metadata, { name: 'Fixture USD', symbol: 'FUSD', decimals: 6 });
    const { review, hash } = await submit(f, token);
    assert.equal(review.asset, 'ERC-20');
    assert.equal(review.amount, '1234567');
    assert.equal(review.displayAmount, '1.234567');
    assert.deepEqual(review.tokenMetadata, balance.metadata);
    assert.equal(review.tokenId, null);
    assert.equal(review.transaction.value, '0x0');
    assert.equal(review.transaction.to, address);
    assert.equal(review.transaction.data, token.interface.encodeFunctionData('transfer', [recipient, 1234567n]));
    assert.equal(review.codeHash, ethers.keccak256(await rpc.getCode(address)));
    assert.equal((await f.wallet.reconcile(1n)).state, 'confirmed');
    assert.equal((await rpc.getTransaction(hash)).chainId, BigInt(chainId));
    assert.equal(await token.balanceOf(actor), 8765433n);
    assert.equal(await token.balanceOf(recipient), 1234567n);
    assert.equal(await token.allowance(actor, recipient), 0n);
    assert.ok(!f.calls.some(call => call.data.startsWith('0x01ffc9a7')));
    assert.ok(!f.methods.some(method => /sign|typedData|personal/i.test(method)));
    await f.wallet.acknowledge(1n);
    assert.equal((await f.wallet.status()).status, 'idle');
    assert.equal(f.sends(), 1);
  });

  it('accepts legacy empty transfer return data and confirms the exact real Transfer event', async () => {
    const token = await deploy(Return.Empty), f = session();
    await submit(f, token, '1000001');
    assert.equal((await f.wallet.reconcile(1n)).state, 'confirmed');
    assert.equal(await token.balanceOf(recipient), 1000001n);
    await f.wallet.acknowledge(1n);
    assert.equal(f.sends(), 1);
  });

  for (const mode of ['False', 'Short', 'InvalidBool', 'TrailingData', 'Revert']) {
    it(`refuses ${mode} transfer simulation before any wallet send`, async () => {
      const token = await deploy(Return[mode]), f = session();
      await assert.rejects(f.wallet.prepare(await request(token)));
      assert.equal(f.sends(), 0);
      assert.equal(await token.balanceOf(actor), 10000000n);
      assert.equal(await token.balanceOf(recipient), 0n);
    });
  }

  for (const mode of ['Absent', 'Malformed']) {
    it(`keeps raw-unit transfers usable with ${mode.toLowerCase()} optional metadata`, async () => {
      const token = await deploy(Return.True, Metadata[mode]), f = session();
      const balance = await f.wallet.erc20Balance(await token.getAddress());
      assert.equal(balance.balanceRaw, '10000000');
      assert.deepEqual(balance.metadata, { name: null, symbol: null, decimals: null });
      const { review } = await submit(f, token, '1');
      assert.equal(review.amount, '1');
      assert.equal(review.displayAmount, null);
      assert.deepEqual(review.tokenMetadata, balance.metadata);
      assert.equal((await f.wallet.reconcile(1n)).state, 'confirmed');
      assert.equal(await token.balanceOf(recipient), 1n);
    });
  }

  it('rejects zero, fractional, numeric, and excessive raw amounts without sending', async () => {
    const token = await deploy(), f = session();
    for (const amount of ['0', '1.5', 1, '10000001']) {
      await assert.rejects(f.wallet.prepare(await request(token, amount)));
    }
    assert.equal(f.sends(), 0);
  });

  for (const mode of ['Fee', 'WrongFrom', 'WrongTo', 'IndexedAmount', 'ExtraData', 'Missing', 'OtherContract']) {
    it(`will not claim success from a mined ${mode} token effect`, async () => {
      const token = await deploy(Return.True, Metadata.Present, Effect[mode]), f = session();
      const { hash } = await submit(f, token, '100');
      assert.equal((await rpc.getTransactionReceipt(hash)).status, 1);
      assert.equal(await token.balanceOf(recipient), mode === 'Fee' ? 99n : 100n);
      await assert.rejects(f.wallet.reconcile(1n), /ASSET_ERC20_EFFECT_UNOBSERVED/);
      await assert.rejects(f.wallet.acknowledge(1n), /ASSET_ERC20_EFFECT_UNOBSERVED/);
      assert.equal((await f.wallet.status()).status, 'submitted');
      assert.equal(f.sends(), 1);
    });
  }

  it('does not certify future balances after an unsupported token rebase', async () => {
    const token = await deploy(), f = session(), { hash } = await submit(f, token, '1000000');
    assert.equal(await token.balanceOf(recipient), 1000000n);
    assert.equal((await f.wallet.reconcile(1n)).state, 'confirmed');
    // An independent later token operation rebases the received balance. The
    // original canonical event remains execution evidence, never a guarantee
    // of present or future balances or support for arbitrary rebase economics.
    await (await token.rebaseBalanceForTest(recipient, 250000n)).wait();
    assert.equal(await token.balanceOf(recipient), 250000n);
    const receipt = await f.wallet.reconcile(1n);
    assert.deepEqual(receipt, { state: 'confirmed', transactionHash: hash, confirmations: '2' });
    const canonical = await rpc.getTransactionReceipt(hash);
    const transfer = token.interface.parseLog(canonical.logs[0]);
    assert.equal(transfer.name, 'Transfer');
    assert.equal(transfer.args[2], 1000000n);
    await f.wallet.acknowledge(1n);
    assert.equal((await f.wallet.status()).status, 'idle');
    assert.equal(f.sends(), 1);
  });

  it('pins runtime code across review and submission even when behavior is unchanged', async () => {
    const token = await deploy(), f = session(), text = await request(token);
    const review = await f.wallet.prepare(text), address = await token.getAddress();
    const code = await local.request({ method: 'eth_getCode', params: [address, 'latest'] });
    // Appending an unreachable byte preserves behavior but changes the runtime hash.
    await local.request({ method: 'hardhat_setCode', params: [address, `${code}00`] });
    await assert.rejects(f.wallet.submit(review, review.digest), /ASSET_REVIEW_CHANGED/);
    assert.equal(f.sends(), 0);
    assert.equal((await f.wallet.status()).status, 'idle');
  });

  it('invalidates a review after a real intervening nonce-consuming transaction', async () => {
    const token = await deploy(), f = session();
    const review = await f.wallet.prepare(await request(token));
    await (await signer.sendTransaction({ to: outsider, value: 1n })).wait();
    await assert.rejects(f.wallet.submit(review, review.digest), /ASSET_REVIEW_CHANGED/);
    assert.equal(f.sends(), 0);
    assert.equal(await token.balanceOf(recipient), 0n);
  });

  it('persists owner rejection without consuming a nonce and requires a fresh explicit retry', async () => {
    const token = await deploy(), f = session({ reject: true });
    const review = await f.wallet.prepare(await request(token));
    const nonce = await local.request({ method: 'eth_getTransactionCount', params: [actor, 'pending'] });
    await assert.rejects(f.wallet.submit(review, review.digest), /CONTROL_PROVIDER_REQUEST_REJECTED/);
    assert.equal((await f.create().status()).status, 'idle');
    assert.equal(await local.request({ method: 'eth_getTransactionCount', params: [actor, 'pending'] }), nonce);
    assert.equal(await token.balanceOf(recipient), 0n);
    assert.equal(f.sends(), 1);
    f.options.reject = false;
    const restarted = f.create(), fresh = await restarted.prepare(await request(token));
    await restarted.submit(fresh, fresh.digest);
    assert.equal((await restarted.reconcile(1n)).state, 'confirmed');
    assert.equal(f.sends(), 2);
  });

  it('reloads a submitted operation, waits for depth and never duplicates the send', async () => {
    const token = await deploy(), f = session(), { review } = await submit(f, token);
    const restarted = f.create();
    await assert.rejects(restarted.submit(review, review.digest), /ASSET_RECONCILIATION_REQUIRED/);
    assert.equal((await restarted.reconcile(2n)).state, 'confirming');
    await assert.rejects(restarted.acknowledge(2n), /ASSET_TERMINAL_RECEIPT_REQUIRED/);
    await local.request({ method: 'evm_mine', params: [] });
    assert.equal((await restarted.reconcile(2n)).state, 'confirmed');
    await restarted.acknowledge(2n);
    assert.equal((await restarted.status()).status, 'idle');
    assert.equal(f.sends(), 1);
    assert.equal(await token.balanceOf(recipient), 1234567n);
  });

  it('recovers the exact mined hash after a lost send response without another send', async () => {
    const token = await deploy(), f = session({ loseResponse: true });
    const review = await f.wallet.prepare(await request(token));
    await assert.rejects(f.wallet.submit(review, review.digest), /CONTROL_PROVIDER_OUTCOME_UNCERTAIN/);
    const restarted = f.create();
    assert.equal((await restarted.status()).status, 'outcome-unknown');
    await assert.rejects(restarted.submit(review, review.digest), /ASSET_RECONCILIATION_REQUIRED/);
    const unrelated = await signer.sendTransaction({ to: outsider, value: 1n });
    await unrelated.wait();
    await assert.rejects(restarted.recover(unrelated.hash, 1n), /ASSET_(?:RECEIPT|TRANSACTION)_BINDING_REFUSED/);
    assert.equal((await restarted.recover(f.minedHash(), 1n)).state, 'confirmed');
    await restarted.acknowledge(1n);
    assert.equal((await restarted.status()).status, 'idle');
    assert.equal(f.sends(), 1);
    assert.equal(await token.balanceOf(recipient), 1234567n);
  });
});
