// Deterministic browser/provider regression only. No genuine wallet, private key,
// signing implementation or network RPC. Does not establish production acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.XIONGAN_SMOKE_OUTPUT || '/tmp/xiongan-ui-evidence');
fs.mkdirSync(out, { recursive: true });
const port = 18415, origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(__dirname, 'serve-browser.cjs')], { env: { ...process.env, WALLET_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
(async () => {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const evidence = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const externalRequests = [], errors = [];
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(origin)) { externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(() => {
      const actor = `0x${'1'.repeat(40)}`, blockHash = `0x${'4'.repeat(64)}`, transactionHash = `0x${'5'.repeat(64)}`;
      const events = new Map();
      const state = globalThis.__xionganTest = { mode: 'normal', sends: Number(sessionStorage.getItem('test-sends') || 0), actor, holdEstimate: false, gate: null, release: null };
      globalThis.ethereum = {
        on(event, fn) { const list = events.get(event) || []; list.push(fn); events.set(event, list); },
        async request({ method, params = [] }) {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.actor];
          if (method === 'eth_chainId') return '0x1';
          if (method === 'eth_getCode') return '0x';
          if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: blockHash };
          if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
          if (method === 'eth_getTransactionCount') return '0x0';
          if (method === 'eth_estimateGas') {
            if (state.holdEstimate) { state.gate = 'estimate'; await new Promise(r => { state.release = r; }); state.holdEstimate = false; }
            return '0x5208';
          }
          if (method === 'eth_sendTransaction') {
            state.sends++; sessionStorage.setItem('test-sends', String(state.sends)); sessionStorage.setItem('test-tx', JSON.stringify(params[0]));
            if (state.mode === 'hold-send') { state.gate = 'send'; await new Promise(r => { state.release = r; }); }
            if (state.mode === 'unknown') throw new Error('simulated response loss');
            return transactionHash;
          }
          const sent = JSON.parse(sessionStorage.getItem('test-tx') || 'null');
          if (method === 'eth_blockNumber') return '0x65';
          if (method === 'eth_getTransactionByHash') return { ...sent, input: sent.data, hash: transactionHash, blockNumber: '0x64', blockHash, transactionIndex: '0x0' };
          if (method === 'eth_getTransactionReceipt') return { from: actor, to: sent.to, transactionHash, blockNumber: '0x64', blockHash, transactionIndex: '0x0', status: '0x1', logs: [] };
          throw new Error(`unexpected method ${method}`);
        },
      };
      state.emit = (event, account) => { state.actor = account || state.actor; for (const fn of events.get(event) || []) fn([state.actor]); };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); const idle = () => page.waitForFunction(() => !document.getElementById('asset-connect').disabled);
    const connect = async () => { await page.click('#asset-connect'); await page.waitForFunction(() => document.getElementById('asset-identity').textContent.includes('Ethereum')); await idle(); };
    const prepare = async () => {
      await page.fill('#asset-recipient', `0x${'2'.repeat(40)}`); await page.fill('#asset-amount', '1000'); await page.click('#asset-prepare');
      await page.waitForFunction(() => document.getElementById('asset-review-text').textContent.includes('digest')); await idle();
    };
    await connect(); await prepare(); assert.equal(await page.evaluate(() => __xionganTest.sends), 0);
    // A -> B -> A revokes the pending generation even if the final account matches.
    await page.evaluate(() => { __xionganTest.holdEstimate = true; }); await page.check('#asset-ack'); await page.click('#asset-send');
    await page.waitForFunction(() => __xionganTest.gate === 'estimate');
    await page.evaluate(() => { __xionganTest.emit('accountsChanged', `0x${'2'.repeat(40)}`); __xionganTest.emit('accountsChanged', `0x${'1'.repeat(40)}`); __xionganTest.release(); });
    await idle(); assert.equal(await page.evaluate(() => __xionganTest.sends), 0);
    assert.match(await page.locator('#asset-receive').textContent(), /No receive address verified/);
    await connect(); await prepare(); await page.evaluate(() => { __xionganTest.mode = 'hold-send'; __xionganTest.gate = null; });
    await page.check('#asset-ack'); await page.click('#asset-send'); await page.waitForFunction(() => __xionganTest.gate === 'send');
    assert.equal(await page.locator('[data-action="create-account"]').isDisabled(), true);
    await page.evaluate(() => { document.querySelector('[data-action="create-account"]').dispatchEvent(new MouseEvent('click')); });
    assert.equal(await page.locator('#asset-send').isDisabled(), true);
    await page.evaluate(() => __xionganTest.release()); await idle();
    assert.equal(await page.evaluate(() => __xionganTest.sends), 1);
    await page.reload(); await connect(); assert.match(await page.locator('#asset-state').textContent(), /submitted/);
    assert.equal(await page.evaluate(() => __xionganTest.sends), 1);
    await page.click('#asset-reconcile'); await idle(); assert.match(await page.locator('#asset-result').textContent(), /confirmed/);
    await page.click('#asset-ack-terminal'); await idle(); assert.match(await page.locator('#asset-state').textContent(), /"idle"/);
    // Persist a sent-but-response-lost operation, restart, reject a duplicate, recover.
    await prepare(); await page.evaluate(() => { __xionganTest.mode = 'unknown'; }); await page.check('#asset-ack'); await page.click('#asset-send'); await idle();
    assert.match(await page.locator('#asset-state').textContent(), /outcome-unknown/); await page.reload(); await connect();
    await prepare(); await page.check('#asset-ack'); await page.click('#asset-send'); await idle();
    assert.match(await page.locator('#asset-result').textContent(), /ASSET_RECONCILIATION_REQUIRED/);
    assert.equal(await page.evaluate(() => __xionganTest.sends), 2);
    await page.fill('#asset-recovery-hash', `0x${'5'.repeat(64)}`); await page.click('#asset-recover'); await idle();
    assert.match(await page.locator('#asset-result').textContent(), /confirmed/);
    await page.screenshot({ path: path.join(out, `xiongan-${viewport.width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    evidence.push({ viewport, provider: 'synthetic-no-signing-no-rpc', journeys: ['prepare-no-send', 'A-B-A-revocation', 'cross-panel-lock', 'submit-reload-reconcile', 'unknown-restart-no-resend-recover'], sends: 2, errors, externalRequests });
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ verdict: 'SYNTHETIC_BROWSER_REGRESSION_PASSED_NOT_REAL_WALLET_ACCEPTANCE', evidence }, null, 2));
  console.log(JSON.stringify({ passed: true, out, profiles: evidence.length }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill('SIGTERM'); });
