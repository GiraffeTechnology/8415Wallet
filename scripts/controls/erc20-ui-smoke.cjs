// Actual Chromium, DOM and strict IndexedDB regression with a synthetic ERC-20
// provider. No real wallet, keys, signatures or network RPC; no device acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.ERC20_UI_OUTPUT || '/tmp/8415-erc20-ui-evidence');
const port = 18418, origin = `http://127.0.0.1:${port}`;
const actor = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`;
const transactionHash = `0x${'5'.repeat(64)}`;
const release = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));

async function installProvider(context) {
  await context.addInitScript(() => {
    const actor = `0x${'1'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`, blockHash = `0x${'4'.repeat(64)}`, transactionHash = `0x${'5'.repeat(64)}`;
    const word = number => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
    const string = value => `${word(32)}${word(value.length).slice(2)}${Array.from(value, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0')}`;
    const state = globalThis.__erc20Test = { mode: 'normal', sends: Number(sessionStorage.getItem('erc20-test-sends') || 0),
      accountRequests: 0, missingDecimals: false, badEvent: false, gate: null, release: null };
    globalThis.ethereum = { on() {}, async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts') { state.accountRequests++; return [actor]; }
      if (method === 'eth_accounts') return [actor];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getCode') return params[0] === contract ? '0x6000' : '0x';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: blockHash };
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_estimateGas') return '0xc350';
      if (method === 'eth_call') {
        const data = params[0].data;
        if (data.startsWith('0x70a08231')) return word('9007199254740993000001');
        if (data.startsWith('0xa9059cbb')) return word(1);
        if (data === '0x313ce567') return state.missingDecimals ? '0x' : word(6);
        if (data === '0x06fdde03') return string('Test token');
        if (data === '0x95d89b41') return string('TEST');
        throw new Error('Unexpected ERC-20 call');
      }
      if (method === 'eth_sendTransaction') {
        state.sends++; sessionStorage.setItem('erc20-test-sends', String(state.sends));
        if (state.mode === 'reject') throw Object.assign(new Error('Synthetic wallet cancellation'), { code: 4001 });
        sessionStorage.setItem('erc20-test-tx', JSON.stringify(params[0]));
        if (state.mode === 'hold-send') { state.gate = 'send'; await new Promise(resolve => { state.release = resolve; }); }
        if (state.mode === 'unknown') throw new Error('Synthetic response loss after submission');
        return transactionHash;
      }
      const sent = JSON.parse(sessionStorage.getItem('erc20-test-tx') || 'null');
      if (method === 'eth_blockNumber') return '0x65';
      if (method === 'eth_getTransactionByHash') return { ...sent, input: sent.data, hash: transactionHash, blockNumber: '0x64', blockHash, transactionIndex: '0x0' };
      if (method === 'eth_getTransactionReceipt') return { from: actor, to: sent.to, transactionHash,
        blockNumber: '0x64', blockHash, transactionIndex: '0x0', status: '0x1', logs: [{ address: contract,
          transactionHash, blockHash, blockNumber: '0x64', transactionIndex: '0x0', removed: false,
          topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(24)}${actor.slice(2)}`, `0x${sent.data.slice(10, 74)}`],
          data: state.badEvent ? word(1) : `0x${sent.data.slice(74, 138)}` }] };
      throw new Error(`Unexpected method ${method}`);
    } };
  });
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, 'serve-browser.cjs')], {
    env: { ...process.env, WALLET_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser, stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Local browser server did not start: ${stderr}`)), 15000);
      server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local browser server exited ${code}: ${stderr}`)); });
    });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const evidence = [];
    for (const profile of ['v2', 'v3']) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport }), errors = [], externalRequests = [];
        await context.route('**/*', route => {
          if (!route.request().url().startsWith(`${origin}/`)) { externalRequests.push(route.request().url()); return route.abort(); }
          if (route.request().url() === `${origin}/web/release-config.json`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...release, profile }) });
          return route.continue();
        });
        await installProvider(context);
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        const idle = () => page.waitForFunction(() => !document.getElementById('asset-connect').disabled);
        const connect = async () => {
          await page.click('#asset-connect'); await page.waitForFunction(() => document.getElementById('asset-identity').textContent.includes('Ethereum'));
          await idle();
        };
        const prepare = async () => {
          await page.selectOption('#asset-kind', 'erc20-transfer'); await page.fill('#asset-contract', contract);
          await page.fill('#asset-recipient', recipient); await page.fill('#asset-amount', '1234567'); await page.click('#asset-prepare');
          await page.waitForFunction(() => document.getElementById('asset-review-text').textContent.includes('digest')); await idle();
        };
        const sends = () => page.evaluate(() => __erc20Test.sends);
        await page.goto(origin); await connect();
        assert.ok((await page.textContent('#release-profile')).includes(profile === 'v2' ? '2.2.0-beta' : '3.0.0-beta'));
        assert.equal(await page.locator('#linked-tab').isVisible(), profile === 'v3');
        await page.fill('#asset-contract', contract); await page.click('#asset-token-balance'); await idle();
        const balance = JSON.parse(await page.textContent('#asset-result'));
        assert.equal(balance.chainId, '1'); assert.equal(balance.contract, contract); assert.equal(balance.account, actor);
        assert.equal(balance.balanceRaw, '9007199254740993000001'); assert.equal(balance.displayBalance, '9007199254740993.000001');
        await prepare(); let review = JSON.parse(await page.textContent('#asset-review-text'));
        assert.equal(review.amount, '1234567'); assert.equal(review.displayAmount, '1.234567'); assert.equal(review.transaction.to, contract);
        assert.equal(review.transaction.value, '0x0'); assert.equal(review.tokenMetadata.decimals, 6); assert.equal(await sends(), 0);
        // Fractional input is not silently converted or rounded into raw units.
        await page.check('#asset-ack'); await page.fill('#asset-amount', '1.234567');
        assert.equal(await page.isChecked('#asset-ack'), false); assert.equal(await page.textContent('#asset-review-text'), 'No transfer reviewed');
        await page.click('#asset-prepare'); await idle(); assert.equal(await page.textContent('#asset-result'), 'ASSET_INTEGER_REFUSED');
        await page.evaluate(() => { __erc20Test.missingDecimals = true; }); await prepare();
        review = JSON.parse(await page.textContent('#asset-review-text'));
        assert.equal(review.displayAmount, null); assert.match(review.humanAmount, /decimals unknown/); assert.equal(await sends(), 0);
        await page.evaluate(() => { __erc20Test.missingDecimals = false; }); await prepare();
        await page.click('#asset-send'); await idle(); assert.match(await page.textContent('#asset-result'), /ASSET_OWNER_REVIEW_REQUIRED/);
        assert.equal(await sends(), 0);
        await page.evaluate(() => { __erc20Test.mode = 'reject'; }); await page.check('#asset-ack'); await page.click('#asset-send'); await idle();
        assert.match(await page.textContent('#asset-result'), /Cancelled in your wallet/); assert.match(await page.textContent('#asset-state'), /"status": "idle"/);
        assert.equal(await page.textContent('#asset-review-text'), 'No transfer reviewed'); assert.equal(await sends(), 1);
        await page.click('#asset-send'); await idle(); assert.equal(await sends(), 1);
        await prepare(); await page.evaluate(() => { __erc20Test.mode = 'hold-send'; });
        await page.check('#asset-ack'); await page.click('#asset-send'); await page.waitForFunction(() => __erc20Test.gate === 'send');
        assert.equal(await page.isDisabled('#asset-send'), true);
        // Deliberately dispatch a second event while disabled to exercise the
        // handler's busy guard as well as the native disabled control.
        await page.evaluate(() => { document.getElementById('asset-send').dispatchEvent(new MouseEvent('click'));
          document.getElementById('asset-connect').dispatchEvent(new MouseEvent('click')); });
        assert.equal(await sends(), 2); await page.evaluate(() => __erc20Test.release()); await idle();
        assert.match(await page.textContent('#asset-state'), /submitted/);
        await page.reload(); await connect(); assert.equal(await sends(), 2); assert.match(await page.textContent('#asset-state'), /submitted/);
        await page.evaluate(() => { __erc20Test.badEvent = true; }); await page.click('#asset-reconcile'); await idle();
        assert.equal(await page.textContent('#asset-result'), 'ASSET_ERC20_EFFECT_UNOBSERVED'); assert.match(await page.textContent('#asset-state'), /submitted/);
        await page.evaluate(() => { __erc20Test.badEvent = false; }); await page.click('#asset-reconcile'); await idle();
        assert.match(await page.textContent('#asset-result'), /"state": "confirmed"/);
        await page.click('#asset-ack-terminal'); await idle(); assert.match(await page.textContent('#asset-state'), /"status": "idle"/);
        await prepare(); await page.evaluate(() => { __erc20Test.mode = 'unknown'; }); await page.check('#asset-ack'); await page.click('#asset-send'); await idle();
        assert.match(await page.textContent('#asset-state'), /outcome-unknown/); assert.equal(await sends(), 3);
        await page.reload(); await connect(); assert.match(await page.textContent('#asset-state'), /outcome-unknown/); assert.equal(await sends(), 3);
        await prepare(); await page.check('#asset-ack'); await page.click('#asset-send'); await idle();
        assert.equal(await page.textContent('#asset-result'), 'ASSET_RECONCILIATION_REQUIRED'); assert.equal(await sends(), 3);
        await page.fill('#asset-recovery-hash', transactionHash); await page.click('#asset-recover'); await idle();
        assert.match(await page.textContent('#asset-result'), /"state": "confirmed"/); assert.equal(await sends(), 3);
        await page.click('#asset-ack-terminal'); await idle(); assert.match(await page.textContent('#asset-state'), /"status": "idle"/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#asset-panel').screenshot({ path: path.join(out, `erc20-${profile}-${viewport.width}.png`) });
        assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
        evidence.push({ profile, viewport, provider: 'synthetic-no-signing-no-rpc', sends: 3,
          journeys: ['explicit-token-balance', 'six-decimal-exact-display', 'raw-integer-refusal', 'unknown-decimals', 'no-ack-no-send',
            'numeric-4001-review-clearing', 'duplicate-click', 'submitted-reload', 'mismatched-effect-refusal', 'canonical-receipt',
            'unknown-reload-no-resend', 'exact-hash-recovery', 'terminal-acknowledgement', 'no-horizontal-overflow'], errors, externalRequests });
        await context.close();
      }
    }
    // A missing release profile is a pre-provider failure, never a fallback to
    // mainnet or an implicitly selected product profile.
    const blocked = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await blocked.route('**/*', route => {
      if (!route.request().url().startsWith(`${origin}/`)) return route.abort();
      if (route.request().url() === `${origin}/web/release-config.json`) return route.fulfill({ status: 404, body: 'Missing config' });
      return route.continue();
    });
    await installProvider(blocked); const blockedPage = await blocked.newPage(); await blockedPage.goto(origin);
    await blockedPage.click('#asset-connect');
    await blockedPage.waitForFunction(() => document.getElementById('asset-result').textContent === 'ASSET_RELEASE_CONFIG_REFUSED');
    assert.equal(await blockedPage.evaluate(() => __erc20Test.accountRequests), 0);
    assert.equal(await blockedPage.evaluate(() => __erc20Test.sends), 0);
    evidence.push({ profileGate: 'missing-config-refused-before-provider', accountRequests: 0, sends: 0 }); await blocked.close();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
      verdict: 'SYNTHETIC_CHROMIUM_INDEXEDDB_REGRESSION_PASSED_NOT_REAL_WALLET_ACCEPTANCE', evidence }, null, 2));
    console.log(JSON.stringify({ passed: true, out, profiles: 2, viewports: 2, evidenceCases: evidence.length }));
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
