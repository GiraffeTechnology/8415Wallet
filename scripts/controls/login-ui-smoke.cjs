const { installScreenNavigation } = require('./screen-navigation.cjs');
// Rendered browser regression with public synthetic test keys only. No genuine
// wallet, user signatures, network RPC, chain transaction or physical handset.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { installSyntheticLoginSigner, login } = require('./synthetic-login.cjs');
const root = path.resolve(__dirname, '../..'), port = 18419, origin = `http://127.0.0.1:${port}`;
const out = path.resolve(process.env.LOGIN_UI_OUTPUT || '/tmp/8415-login-ui-evidence');
const release = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, 'serve-browser.cjs')], { env: { ...process.env, WALLET_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Static server exited: ${code}`))); });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const evidence = [];
    for (const profile of ['v2', 'v3']) for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const errors = [], externalRequests = [];
      await context.route('**/*', route => {
        if (!route.request().url().startsWith(`${origin}/`)) { externalRequests.push(route.request().url()); return route.abort(); }
        if (route.request().url() === `${origin}/web/release-config.json`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...release, profile }) });
        return route.continue();
      });
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const actor = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', listeners = new Map();
        const state = globalThis.__loginTest = { actor, chain: '0x1', mode: 'normal', calls: [], gate: null, release: null, lastSignature: null };
        const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
        globalThis.ethereum = {
          on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
          removeListener(event, fn) { listeners.get(event)?.delete(fn); },
          async request({ method, params = [] }) {
            state.calls.push(method);
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.actor];
            if (method === 'eth_chainId') return state.chain;
            if (method === 'personal_sign') {
              if (state.mode === 'reject') throw { code: 4001, message: 'Untrusted provider detail must not appear' };
              if (state.mode === 'hold-sign') { state.gate = 'sign'; await new Promise(resolve => { state.release = resolve; }); }
              if (state.mode === 'invalid') return '0x1234';
              if (state.mode === 'replay') return state.lastSignature;
              const signature = await globalThis.__syntheticLoginSign(params[0]); state.lastSignature = signature; return signature;
            }
            if (method === 'eth_getCode') return params[0].toLowerCase() === actor ? '0x' : '0x6000';
            if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'4'.repeat(64)}` };
            if (method === 'eth_getBalance') {
              if (state.mode === 'hold-read') { state.gate = 'read'; await new Promise(resolve => { state.release = resolve; }); }
              return '0xde0b6b3a7640000';
            }
            if (method === 'eth_call') {
              if (state.mode === 'hold-token') { state.gate = 'token'; await new Promise(resolve => { state.release = resolve; }); }
              if (params[0].data.startsWith('0x70a08231')) return word(1234567);
              if (params[0].data === '0x313ce567') return word(6);
              return '0x';
            }
            if (method === 'eth_sendTransaction' || method.startsWith('eth_sign')) throw new Error('No transaction authorization in login tests');
            throw new Error(`Unexpected synthetic method ${method}`);
          },
        };
        state.emit = event => { for (const listener of [...listeners.get(event) ?? []]) listener(); };
      });
      const page = installScreenNavigation(await context.newPage()); await page.clock.install(); page.on('pageerror', error => errors.push(error.message));
      const idle = () => page.waitForFunction(() => !document.getElementById('asset-connect').disabled && !document.getElementById('wallet-login').disabled);
      const locked = async () => {
        assert.equal(await page.locator('#wallet-private').isVisible(), false);
        assert.equal(await page.locator('#wallet-login').isVisible(), true);
        assert.doesNotMatch(await page.locator('#asset-result').textContent(), /balanceWei|1234567/);
        assert.doesNotMatch(await page.locator('#asset-state').textContent(), /transactionHash/);
        assert.equal(await page.locator('#asset-review-text').textContent(), 'No transfer reviewed');
        assert.equal(await page.locator('#settlement-terms').textContent(), 'No settlement reviewed');
        assert.equal(await page.locator('#clearing-review').textContent(), 'No clearing review prepared');
      };
      const loadAssets = async () => {
        await login(page); await page.click('#asset-connect'); await idle();
        assert.match(await page.textContent('#asset-result'), /balanceWei/);
      };
      await page.goto(origin); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => __loginTest.calls), []);
      // Direct synthetic event dispatch must not bypass the hidden/inert UI.
      for (const selector of ['#asset-connect', '#asset-balance', '#asset-token-balance', '[data-read="asset"]', '[data-read="history"]', '[data-read="ownership"]', '#clearing-observe']) {
        await page.locator(selector).dispatchEvent('click'); await idle();
      }
      assert.deepEqual(await page.evaluate(() => __loginTest.calls), []);
      await page.evaluate(() => ethereum.request({ method: 'eth_requestAccounts' }));
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      for (const mode of ['reject', 'invalid']) {
        await page.evaluate(mode => { __loginTest.mode = mode; }, mode); await page.click('#wallet-login'); await idle(); await locked();
        assert.equal(await page.evaluate(() => __loginTest.calls.includes('eth_getBalance')), false);
      }
      await page.evaluate(() => { __loginTest.mode = 'hold-sign'; __loginTest.gate = null; });
      await page.click('#wallet-login'); await page.waitForFunction(() => __loginTest.gate === 'sign');
      const signatures = await page.evaluate(() => __loginTest.calls.filter(m => m === 'personal_sign').length);
      await page.locator('#wallet-login').dispatchEvent('click');
      assert.equal(await page.evaluate(() => __loginTest.calls.filter(m => m === 'personal_sign').length), signatures);
      await page.click('#wallet-logout'); await page.evaluate(() => __loginTest.release()); await idle(); await locked();
      await page.evaluate(() => { __loginTest.mode = 'normal'; }); await loadAssets();
      assert.equal(await page.evaluate(() => __loginTest.calls.includes('eth_sendTransaction')), false);
      for (const id of ['asset-recipient', 'asset-contract', 'asset-recovery-hash', 'clearing-trade-key', 'clearing-recovery-hash', 'settlement-recovery-hash', 'recovery-hash']) {
        await page.locator(`#${id}`).evaluate(node => { node.value = 'previous-account-private-display'; });
      }
      await page.click('#wallet-logout'); await locked();
      for (const id of ['asset-recipient', 'asset-contract', 'asset-recovery-hash', 'clearing-trade-key', 'clearing-recovery-hash', 'settlement-recovery-hash', 'recovery-hash']) assert.equal(await page.inputValue(`#${id}`), '');
      await page.evaluate(() => { __loginTest.mode = 'replay'; }); await page.click('#wallet-login'); await idle(); await locked();
      await page.evaluate(() => { __loginTest.mode = 'normal'; }); await loadAssets();
      // State or signature fields in browser storage never authenticate a reload.
      await page.evaluate(() => { localStorage.setItem('authenticated', 'true'); sessionStorage.setItem('wallet-session', JSON.stringify({ authenticated: true })); });
      await page.reload(); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      await locked(); assert.deepEqual(await page.evaluate(() => __loginTest.calls), []); await loadAssets();
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
        await page.evaluate(event => __loginTest.emit(event), event); await locked(); await loadAssets();
      }
      // Silent identity changes are checked before the next read even if a provider misses its event.
      await page.evaluate(() => { __loginTest.actor = `0x${'2'.repeat(40)}`; });
      await page.click('#asset-balance'); await idle(); await locked();
      await page.evaluate(() => { __loginTest.actor = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'; }); await loadAssets();
      for (const mode of ['hold-read', 'hold-token', 'silent-account', 'silent-chain']) {
        await page.evaluate(mode => { __loginTest.mode = mode.startsWith('silent-') ? 'hold-read' : mode; __loginTest.gate = null; }, mode);
        if (mode === 'hold-token') { await page.fill('#asset-contract', `0x${'3'.repeat(40)}`); await page.click('#asset-token-balance'); }
        else await page.click('#asset-balance');
        await page.waitForFunction(() => __loginTest.gate !== null);
        if (mode === 'silent-account') await page.evaluate(() => { __loginTest.actor = `0x${'2'.repeat(40)}`; });
        else if (mode === 'silent-chain') await page.evaluate(() => { __loginTest.chain = '0x2105'; });
        else { await page.click('#wallet-logout'); await locked(); }
        await page.evaluate(() => __loginTest.release()); await idle(); await locked();
        await page.evaluate(() => { __loginTest.mode = 'normal'; __loginTest.actor = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'; __loginTest.chain = '0x1'; }); await loadAssets();
      }
      // Explicit time shift tests operation expiry without waiting for the timer.
      await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 16 * 60 * 1000));
      await page.click('#asset-balance'); await idle(); await locked();
      await page.reload(); await loadAssets();
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))); await locked();
      await loadAssets(); await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await locked();
      assert.equal(await page.evaluate(() => __loginTest.calls.some(m => m === 'eth_sendTransaction' || m.startsWith('eth_sign'))), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
      await page.screenshot({ path: path.join(out, `${profile}-${viewport.width}-locked.png`), fullPage: true });
      evidence.push({ profile, viewport, result: 'passed', journeys: ['public-entry-zero-provider-reads', 'connection-is-not-login', 'reject-invalid-replay', 'cancel-late-signature', 'repeated-click', 'verified-login', 'logout-clear', 'storage-reload-denial', 'account-chain-disconnect', 'silent-account-change', 'late-ETH-and-ERC20-read', 'expiry', 'history-restoration'], userSignatures: 0, chainTransactions: 0 });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ verdict: 'SYNTHETIC_LOGIN_BROWSER_PASSED_NOT_GENUINE_WALLET_ACCEPTANCE', evidence }, null, 2));
    console.log(JSON.stringify({ passed: true, profiles: evidence.length, out }));
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
