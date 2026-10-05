const { installScreenNavigation } = require('./screen-navigation.cjs');
// Actual UI + actual HTTP auth service; ephemeral synthetic accounts only.
// No real user credential, email, transaction, hardware or deployment acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.AUTH_UI_OUTPUT || '/tmp/8415-auth-methods-ui-evidence');
async function main() {
  const { createAuthService } = await import('../../server/auth-service.mjs');
  const { MemoryCredentialStore } = await import('../../server/store.mjs');
  const { hashPassword, hotp } = await import('../../server/crypto.mjs');
  const password = 'synthetic-browser-account-password', passwordHash = await hashPassword(password);
  const actor = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
  const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });
  let auth, profile = 'v2', time = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/')) return auth(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/web/release-config.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...config, profile })); return; }
    const relative = req.url === '/' ? 'web/index.html' : req.url.slice(1), full = path.resolve(root, relative);
    if (!full.startsWith(`${root}/web/`) && !full.startsWith(`${root}/dist/browser/`)) { res.writeHead(404); res.end(); return; }
    try {
      res.setHeader('Content-Type', full.endsWith('.html') ? 'text/html' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : full.endsWith('.jpg') ? 'image/jpeg' : full.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      res.end(fs.readFileSync(full));
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const evidence = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (profile of ['v2', 'v3']) for (const width of [1440, 390]) {
      time = Date.now(); const store = new MemoryCredentialStore();
      auth = createAuthService({ origin, tenant: config.tenant.id, accounts: [{ username: 'tester', passwordHash, wallets: [{ account: actor, chainId: '1' }] }], store, now: () => time });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390 });
      const errors = []; await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const state = globalThis.__authTest = { calls: [], actor: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', hold: false }, listeners = new Map();
        globalThis.ethereum = {
          on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
          removeListener(name, fn) { listeners.get(name)?.delete(fn); },
          async request({ method, params }) {
            state.calls.push(method);
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [state.actor];
            if (method === 'eth_chainId') return '0x1';
            if (method === 'eth_getCode') return '0x';
            if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
            if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'4'.repeat(64)}` };
            if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
            throw new Error(`Unexpected synthetic method: ${method}`);
          },
        };
        state.changeAccount = () => { state.actor = `0x${'2'.repeat(40)}`; for (const fn of listeners.get('accountsChanged') ?? []) fn(); };
      });
      const page = installScreenNavigation(await context.newPage()); await page.clock.install({ time }); page.on('pageerror', error => errors.push(error.message));
      const idle = () => page.waitForFunction(() => !document.getElementById('wallet-login').disabled);
      const unlocked = () => page.waitForFunction(() => !document.getElementById('wallet-private').hidden);
      await page.goto(`${origin}/web/index.html`); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.deepEqual(await page.evaluate(() => globalThis.__authTest.calls), []);
      await page.selectOption('#wallet-login-method', 'password'); await page.fill('#auth-username', 'tester'); await page.fill('#auth-password', 'wrong');
      await page.click('#wallet-login'); await idle(); assert.equal(await page.locator('#wallet-private').isVisible(), false);
      assert.match(await page.textContent('#wallet-login-status'), /AUTH_REFUSED/);
      await page.fill('#auth-password', password); await page.click('#wallet-login'); await unlocked(); await idle();
      assert.equal(await page.inputValue('#auth-password'), '');
      assert.equal((await page.evaluate(() => globalThis.__authTest.calls)).includes('personal_sign'), false);
      await page.click('#asset-connect'); await page.waitForFunction(() => document.getElementById('asset-result').textContent.includes('balanceWei'));
      await page.click('#auth-enroll-start'); await page.waitForFunction(() => document.getElementById('auth-enroll-secret').textContent.includes('otpauth:'));
      const text = await page.textContent('#auth-enroll-secret'), secret = text.match(/\n([A-Z2-7]{32})\n/)[1];
      await page.fill('#auth-enroll-code', hotp(secret, Math.floor(time / 30000))); await page.click('#auth-enroll-confirm');
      await page.waitForFunction(() => !document.getElementById('auth-recovery-output').hidden);
      assert.equal(await page.locator('#wallet-private').isVisible(), false); assert.equal(await page.textContent('#auth-enroll-secret'), '');
      const recovery = (await page.textContent('#auth-recovery-codes')).split('\n'); assert.equal(recovery.length, 8);
      await page.click('#auth-recovery-dismiss'); assert.equal(await page.textContent('#auth-recovery-codes'), '');
      time += 30000; await page.clock.fastForward(30000);
      await page.selectOption('#wallet-login-method', 'totp'); await page.fill('#auth-code', hotp(secret, Math.floor(time / 30000)));
      await page.click('#wallet-login'); await unlocked(); await idle();
      assert.equal(await page.locator('#auth-enrollment').isVisible(), false);
      await page.screenshot({ path: path.join(out, `${profile}-${width}-totp.png`), fullPage: false });
      await page.click('#wallet-logout'); assert.equal(await page.locator('#wallet-private').isVisible(), false);
      await page.fill('#auth-code', hotp(secret, Math.floor(time / 30000))); await page.click('#wallet-login'); await idle();
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      await page.check('#auth-recovery'); await page.fill('#auth-code', recovery[0]); await page.click('#wallet-login'); await unlocked(); await idle();
      await page.click('#wallet-logout'); await page.selectOption('#wallet-login-method', 'wallet'); await page.click('#wallet-login'); await unlocked(); await idle();
      assert.equal((await page.evaluate(() => globalThis.__authTest.calls)).includes('personal_sign'), true);
      await page.evaluate(() => globalThis.__authTest.changeAccount()); assert.equal(await page.locator('#wallet-private').isVisible(), false);
      await page.reload(); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      await page.selectOption('#wallet-login-method', 'ca'); await page.click('#wallet-login'); await idle();
      assert.equal(await page.locator('#wallet-private').isVisible(), false); assert.match(await page.textContent('#wallet-login-status'), /UNAVAILABLE/);
      assert.deepEqual(errors, []);
      evidence.push({ profile, width, password: true, totpEnrollment: true, totpLogin: true, totpReplayRefused: true, recovery: true, registeredWallet: true, accountChangeLocks: true, reloadLocks: true, unavailableCaRefused: true });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ synthetic: true, actualHttpService: true, evidence }, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
