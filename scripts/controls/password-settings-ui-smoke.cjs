const change = require('./method-change-test-ui.cjs');
// Real Chromium + real HTTP authentication; all identities and credentials are synthetic.
// No production site, mailbox, transaction, hardware or real credential is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { installScreenNavigation } = require('./screen-navigation.cjs');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');

async function run() {
  const root = path.resolve(__dirname, '../..');
  const out = path.resolve(process.env.AUTH_UI_OUTPUT || '/tmp/8415-auth-methods-ui-evidence');
  const { createAuthService } = await import('../../server/auth-service.mjs');
  const { MemoryCredentialStore } = await import('../../server/store.mjs');
  const { hotp } = await import('../../server/crypto.mjs');
  const actor = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
  const password = 'synthetic-first-browser-password';
  const replacement = 'synthetic-replacement-browser-password';
  const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
  let profile = 'v2', auth, time = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/')) return auth(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/web/release-config.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ...config, profile }));
    }
    const full = path.resolve(root, req.url === '/' ? 'web/index.html' : req.url.slice(1));
    if (!full.startsWith(`${root}/web/`) && !full.startsWith(`${root}/dist/browser/`)) { res.writeHead(404); return res.end(); }
    try {
      res.setHeader('Content-Type', full.endsWith('.html') ? 'text/html' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : full.endsWith('.jpg') ? 'image/jpeg' : full.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      res.end(fs.readFileSync(full));
    } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const evidence = [];
  try {
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (profile of ['v2', 'v3']) for (const width of [1440, 390]) {
      time = Date.now(); const mail = [], store = new MemoryCredentialStore(change.registeredState(config.tenant.id, 'tester', 'tester@example.invalid', time));
      auth = createAuthService({ origin, tenant: config.tenant.id, accounts: [{ username: 'tester', wallets: [{ account: actor, chainId: '1' }] }], store, now: () => time, sendOtp: async message => { mail.push(message); } });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390 });
      const requests = [], errors = [], offOrigin = [];
      context.on('request', request => { if (!request.url().startsWith(`${origin}/`)) offOrigin.push(request.url()); if (request.url().includes('/auth/')) requests.push(new URL(request.url()).pathname); });
      await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const events = new Map(); globalThis.__passwordCalls = [];
        globalThis.ethereum = { on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, removeListener(name, fn) { events.get(name)?.delete(fn); },
          async request({ method, params }) {
            globalThis.__passwordCalls.push(method);
            if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'];
            if (method === 'eth_chainId') return '0x1';
            if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
            throw Error('Unexpected synthetic provider request');
          } };
      });
      const page = installScreenNavigation(await context.newPage());
      page.on('pageerror', error => errors.push(error.message)); await page.clock.install({ time });
      const idle = () => page.waitForFunction(() => !document.getElementById('wallet-login').disabled);
      const signedOut = () => page.waitForFunction(() => document.getElementById('wallet-private').hidden);
      const settings = async () => { await page.click('#auth-manage-open'); await page.waitForFunction(() => !document.getElementById('auth-password-fields').hidden); };
      const login = async (value = password, method = 'password') => {
        await page.selectOption('#wallet-login-method', method);
        if (method === 'password') { await page.fill('#auth-username', 'tester'); await page.fill('#auth-password', value); }
        await page.click('#wallet-login'); await page.waitForFunction(() => !document.getElementById('wallet-private').hidden); await idle(); await settings();
      };
      const fillPassword = async (value, confirm = value) => { await page.fill('#auth-new-password', value); await page.fill('#auth-new-password-confirm', confirm); };
      const save = options => change.commit(page, '#auth-password-save', options, () => mail.at(-1));
      await page.goto(`${origin}/web/index.html`); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.deepEqual(requests, []); assert.deepEqual(await page.evaluate(() => globalThis.__passwordCalls), []);
      await page.selectOption('#wallet-login-method', 'password');
      await page.click('#auth-initial-open');
      assert.equal(await page.inputValue('#wallet-login-method'), 'wallet');
      assert.deepEqual(await page.evaluate(() => globalThis.__passwordCalls), []);
      await login(password, 'wallet');
      assert.equal(await page.locator('#auth-existing-fields').isVisible(), false);
      assert.equal(await page.isChecked('#auth-enable-wallet'), true);
      assert.equal(await page.isDisabled('#auth-enable-password'), true);
      const beforeMismatch = requests.filter(p => p === '/auth/account/change/start').length;
      await fillPassword(password, 'different-synthetic-password'); await page.click('#auth-password-save');
      assert.equal(requests.filter(p => p === '/auth/account/change/start').length, beforeMismatch);
      assert.equal(await page.inputValue('#auth-new-password'), ''); assert.equal(await page.inputValue('#auth-new-password-confirm'), '');
      await fillPassword(password); const first = await save(); assert.equal(first.status, 200); assert.equal(first.body.loggedOut, true); await signedOut(); await idle();
      assert.equal(await page.inputValue('#auth-new-password'), ''); assert.equal(await page.inputValue('#auth-new-password-confirm'), '');
      await login();
      assert.equal(await page.isChecked('#auth-enable-password'), true); assert.equal(await page.isChecked('#auth-enable-wallet'), true);
      await page.locator('#auth-password-settings').screenshot({ path: path.join(out, `${profile}-${width}-password-settings.png`) });
      // An existing authenticator remains required for password changes.
      await page.click('#auth-enroll-start');
      await change.authorize(page, { password }, () => mail.at(-1));
      await page.waitForFunction(() => document.getElementById('auth-enroll-secret').textContent.includes('otpauth://'));
      const secret = (await page.textContent('#auth-enroll-secret')).match(/\n([A-Z2-7]{32})\n/)[1];
      await page.fill('#auth-enroll-code', hotp(secret, Math.floor(time / 30000))); await page.click('#auth-enroll-confirm');
      await page.waitForFunction(() => !document.getElementById('auth-recovery-output').hidden);
      const recovery = (await page.textContent('#auth-recovery-codes')).split('\n'); await page.click('#auth-recovery-dismiss'); await login();
      await fillPassword(replacement); await page.click('#auth-password-save'); const refused = await change.identity(page, { password }); assert.equal(refused.status, 401);
      assert.equal(await page.inputValue('#auth-new-password'), ''); assert.equal(await page.inputValue('#auth-new-password-confirm'), '');
      await fillPassword(replacement);
      const changed = await save({ password, existingCode: recovery[0], recovery: true }); assert.equal(changed.status, 200); await signedOut(); await idle();
      await login(replacement); assert.equal(await page.isChecked('#auth-enable-wallet'), true); assert.equal(await page.isChecked('#auth-enable-totp'), true);
      // Cancel a pending request before it reaches the HTTP service. It cannot alter the credential.
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { entered = resolve; });
      await page.route('**/auth/account/change/commit', async route => { entered(); await gate; await route.continue(); });
      await fillPassword('synthetic-cancelled-password'); await page.click('#auth-password-save');
      await change.authorize(page, { password: replacement, existingCode: recovery[1], recovery: true }, () => mail.at(-1)); await held;
      const logout = page.waitForResponse(r => r.url().endsWith('/auth/logout'));
      await page.click('#auth-management-close'); await logout; release(); await page.waitForLoadState('networkidle');
      await page.unroute('**/auth/account/change/commit');
      assert.equal(await page.locator('#auth-management').isVisible(), false); assert.equal(await page.inputValue('#auth-new-password'), '');
      await login(replacement); await page.click('#auth-management-close'); await page.click('#wallet-logout'); await signedOut();
      // The old-service capability must provide an actionable version mismatch, without offering a broken form.
      await page.route('**/auth/capabilities', async route => {
        const response = await route.fetch(), value = await response.json(); delete value.passwordManagement;
        await route.fulfill({ response, json: value });
      });
      await page.reload(); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      await page.click('#auth-initial-open'); await page.waitForLoadState('networkidle');
      assert.match(await page.textContent('#auth-password-state'), /update|upgrade/i);
      assert.equal(await page.locator('#auth-password-fields').isVisible(), false);
      assert.deepEqual(errors, []); assert.deepEqual(offOrigin, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      evidence.push({ profile, width, initialWalletProof: true, passwordlessExistingAccount: true, firstPasswordLogin: true,
        mismatchNoRequest: true, existingFactorRequired: true, replacementLogin: true, methodsPreserved: true,
        cancelBeforeCommit: true, inputsCleared: true, oldServiceActionable: true, noOffOriginRequests: true, noOverflow: true });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'password-results.json'), JSON.stringify({ synthetic: true, actualHttpService: true, evidence }, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { change.failure(error); });
