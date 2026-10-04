const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const hre = require('hardhat');
const { requestLocalEip1193 } = require('./local-eip1193.cjs');
const { ethers } = hre;
const hash = value => ethers.keccak256(ethers.toUtf8Bytes(value));
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.SETTLEMENT_UI_OUTPUT || '/tmp/8415-settlement-ui-evidence');

// Local Hardhat + actual Chromium/IndexedDB/layout only. The selected-account
// provider is a test fixture, never a browser extension or public-chain wallet.
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const chainId = (await ethers.provider.getNetwork()).chainId;
  assert.ok([11155111n, 560048n].includes(chainId), 'Use hardhat.rehearsal.config.cjs for the local UI chain');
  const port = 18417, origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, 'serve-browser.cjs')], { env: { ...process.env, WALLET_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const report = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const [admin, registrar, buyer] = await ethers.getSigners();
      const validators = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()].sort((a,b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
      const projection = await (await ethers.getContractFactory('RegisterProjectionReference')).deploy(hash('browser-register'), registrar.address, validators.map(v=>v.address), 2);
      await projection.waitForDeployment(); const now = BigInt((await ethers.provider.getBlock('latest')).timestamp), deadline = now + 600n;
      await projection.connect(admin).mint(registrar.address, 1n, hash('initial'), hash('reference'), now - 100n);
      const manifest = { schema: '8415-controls-testnet/1', chainId: chainId.toString(), controller: null, payment: null,
        token: { address: await projection.getAddress(), runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(await projection.getAddress())) } };
      let sends = 0, rejectSend = false;
      const context = await browser.newContext({ viewport });
      const errors = [], externalRequests = [];
      await context.route('**/*', route => {
        if (!route.request().url().startsWith(origin)) { externalRequests.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await context.exposeFunction('__localSettlementRpc', async args => {
        try {
          if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return { result: [registrar.address] };
          if (args.method === 'eth_sendTransaction') { sends++; if (rejectSend) return { error: { code: 4001 } }; }
          return { result: await requestLocalEip1193(hre.network.provider, args) };
        } catch (error) { return { error: { code: typeof error.code === 'number' ? error.code : -32000 } }; }
      });
      await context.addInitScript(() => {
        const listeners = new Map();
        globalThis.ethereum = { on(name, fn) { const callbacks = listeners.get(name) || []; callbacks.push(fn); listeners.set(name, callbacks); },
          async request(args) { const answer = await globalThis.__localSettlementRpc({ ...args, params: args.params || [] });
            if (answer.error) throw Object.assign(new Error('Local test provider refused'), answer.error); return answer.result; } };
        globalThis.__emitSettlementEvent = name => { for (const callback of listeners.get(name) || []) callback([]); };
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      const idle = () => page.waitForFunction(() => !document.getElementById('connect').disabled);
      const connect = async () => {
        await page.setInputFiles('#deployment', { name: 'deployment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
        await idle(); await page.click('#connect'); await page.waitForFunction(() => document.getElementById('identity').textContent.startsWith('Chain ')); await idle();
      };
      const prepare = async () => { await page.click('#settlement-prepare'); await idle(); await page.waitForFunction(() => document.getElementById('settlement-terms').textContent.includes('digest')); };
      await page.goto(origin); await connect();
      await page.selectOption('#settlement-kind', 'beginSettlement');
      await page.fill('#settlement-id', hash(`browser-gap-${viewport.width}`)); await page.fill('#settlement-holder', buyer.address);
      await page.fill('#settlement-snapshot', hash('snapshot')); await page.fill('#settlement-deadline', deadline.toString());
      await prepare(); assert.equal(sends, 0);
      await page.check('#settlement-ack'); await page.fill('#settlement-holder', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAec');
      assert.equal(await page.isChecked('#settlement-ack'), false); await page.click('#settlement-prepare'); await idle();
      assert.equal(await page.textContent('#settlement-terms'), 'No settlement reviewed'); assert.equal(sends, 0);
      await page.fill('#settlement-holder', buyer.address); await prepare(); await page.click('#settlement-send'); await idle(); assert.equal(sends, 0);
      await page.click('#settlement-dismiss'); await page.check('#settlement-ack'); await page.click('#settlement-send'); await idle(); assert.equal(sends, 0);
      await prepare(); rejectSend = true; await page.check('#settlement-ack'); await page.click('#settlement-send'); await idle();
      assert.match(await page.textContent('#result'), /cancelled/); assert.equal(sends, 1); assert.match(await page.textContent('#settlement-state'), /"status": "idle"/);
      await page.click('#settlement-send'); await idle(); assert.equal(sends, 1);
      rejectSend = false; await prepare(); await page.check('#settlement-ack'); await page.click('#settlement-send'); await idle(); assert.equal(sends, 2);
      assert.match(await page.textContent('#settlement-state'), /submitted/);
      await page.reload(); await connect(); assert.equal(sends, 2); assert.match(await page.textContent('#settlement-state'), /submitted/);
      await hre.network.provider.request({method:'evm_mine',params:[]});
      await page.click('#settlement-reconcile'); await idle(); assert.match(await page.textContent('#result'), /"state": "confirmed"/);
      await page.click('#settlement-ack-terminal'); await idle(); assert.match(await page.textContent('#settlement-state'), /"status": "idle"/);
      await hre.network.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(deadline + 1n)]}); await hre.network.provider.request({method:'evm_mine',params:[]});
      await page.selectOption('#settlement-kind','cancelSettlement'); await page.fill('#settlement-id',hash(`browser-gap-${viewport.width}`));
      await page.fill('#settlement-reason',hash('reason')); await prepare(); assert.match(await page.textContent('#settlement-terms'), /settles nothing/);
      await page.check('#settlement-ack'); await page.click('#settlement-send'); await idle(); assert.equal(sends,3);
      await hre.network.provider.request({method:'evm_mine',params:[]}); await page.click('#settlement-reconcile'); await idle();
      assert.match(await page.textContent('#result'), /"state": "confirmed"/); assert.equal(await projection.entryCount(1n),1n);
      assert.equal(await projection.isFinalAsOf(1n,deadline+1n),false);
      await page.click('#settlement-ack-terminal'); await idle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      await page.locator('#standalone').screenshot({path:path.join(out,`standalone-${viewport.width}.png`)});
      assert.deepEqual(errors,[]); assert.deepEqual(externalRequests,[]);
      report.push({viewport,checks:'begin, checksum refusal, edit invalidation, no-ack, dismiss, numeric-4001, fresh review, submit, reload, reconcile, acknowledge, expired cancel, canonical receipt, no false finality, no horizontal overflow',sends,errors,externalRequests});
      await context.close();
    }
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({method:'Local EVM and Chromium with deterministic selected-account provider; genuine browser IndexedDB; no public network or real wallet',report},null,2));
    console.log(`Standalone browser regression passed ${report.length} viewports; evidence ${out}`);
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
