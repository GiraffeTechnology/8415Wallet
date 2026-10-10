// Actual management UI and HTTP service, synthetic credentials, no external email or provider.
const { installScreenNavigation } = require('./screen-navigation.cjs');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
let phase = 'initialization';
async function run() {
  const { createAuthService } = await import('../../server/auth-service.mjs');
  const { MemoryCredentialStore } = await import('../../server/store.mjs');
  const { hotp } = await import('../../server/crypto.mjs');
  const actor = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', password = 'synthetic method lifecycle password';
  const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json')));
  let auth, profile = 'v2';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/')) return auth(req, res);
    const full = path.resolve(root, req.url === '/' ? 'web/index.html' : req.url.slice(1));
    if (!full.startsWith(`${root}/web/`) && !full.startsWith(`${root}/dist/browser/`)) { res.writeHead(404); return res.end(); }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', full.endsWith('.html') ? 'text/html' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : full.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
    if (req.url === '/web/release-config.json') return res.end(JSON.stringify({ ...config, profile }));
    try { res.end(fs.readFileSync(full)); } catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const results = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (profile of ['v2', 'v3']) for (const width of [1440, 390]) {
      phase = `${profile}-${width}-bootstrap`;
      const messages = [], store = new MemoryCredentialStore();
      auth = createAuthService({ origin, tenant: config.tenant.id, accounts: [{ username: 'tester', wallets: [{ account: actor, chainId: '1' }] }], store,
        sendOtp: async message => { messages.push(message); } });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390 });
      const offOrigin = []; context.on('request', request => { if (!request.url().startsWith(`${origin}/`)) offOrigin.push(true); });
      await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await installSyntheticLoginSigner(context);
      await context.addInitScript(({ actor }) => {
        const listeners = new Map(); globalThis.ethereum = {
          on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
          removeListener(name, fn) { listeners.get(name)?.delete(fn); },
          async request({ method, params }) {
            if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [actor];
            if (method === 'eth_chainId') return '0x1'; if (method === 'eth_getCode') return '0x';
            if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
            throw Error('Unexpected synthetic method');
          },
        };
      }, { actor });
      const page = installScreenNavigation(await context.newPage()), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/web/index.html`); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      const login = async (method = 'wallet') => {
        await page.selectOption('#wallet-login-method', method);
        if (method === 'password') { await page.fill('#auth-username', 'tester'); await page.fill('#auth-password', password); }
        await page.click('#wallet-login'); await page.waitForFunction(() => !document.getElementById('wallet-private').hidden && !document.getElementById('wallet-login').disabled);
        await page.click('#auth-manage-open');
      };
      const verify = async ({ method, recovery } = {}) => {
        const dialog = page.locator('dialog.auth-change-dialog'); await dialog.waitFor();
        if (method) await dialog.locator('select').selectOption(method);
        if ((await dialog.locator('select').inputValue()) === 'password') await dialog.getByLabel('Original password', { exact: true }).fill(password);
        if (recovery) { await dialog.getByLabel('Current authenticator or saved recovery code', { exact: true }).fill(recovery); await dialog.getByLabel('Use a saved recovery code', { exact: true }).check(); }
        const verified = page.waitForResponse(r => r.url().endsWith('/auth/account/change/verify'));
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); const response = await verified; assert.equal(response.status(), 200);
        await dialog.getByLabel('Eight-digit email code', { exact: true }).fill(messages.at(-1).code);
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      };
      const loggedOut = async () => page.waitForFunction(() => document.getElementById('wallet-private').hidden && !document.getElementById('wallet-login').disabled);
      await login();
      // No password, authenticator or verified email exists. Bootstrap the email explicitly.
      await page.fill('#auth-registration-account-email', 'synthetic@example.invalid'); await page.click('#auth-registration-account-start'); await verify({ method: 'wallet' }); await loggedOut();
      let credential = await store.read(`${config.tenant.id}:tester`); assert.equal(credential.registration.email, 'synthetic@example.invalid');
      await login();
      phase = `${profile}-${width}-initial-password`;
      await page.fill('#auth-new-password', password); await page.fill('#auth-new-password-confirm', password); await page.click('#auth-password-save'); await verify({ method: 'wallet' }); await loggedOut();
      await login('password');
      // Cancel during identity verification: no code, secret or durable mutation.
      phase = `${profile}-${width}-authenticator`;
      const before = await store.read(`${config.tenant.id}:tester`), mailBefore = messages.length;
      await page.click('#auth-enroll-start'); await page.locator('dialog.auth-change-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('auth-enroll-start').disabled);
      assert.ok(JSON.stringify(await store.read(`${config.tenant.id}:tester`)) === JSON.stringify(before), 'cancel preserves credential state'); assert.equal(messages.length, mailBefore);
      await page.click('#auth-enroll-start'); await verify();
      await page.waitForFunction(() => document.getElementById('auth-enroll-secret').textContent.includes('otpauth:'));
      const text = await page.textContent('#auth-enroll-secret'), secret = text.match(/\n([A-Z2-7]{32})\n/)[1];
      assert.ok((await store.read(`${config.tenant.id}:tester`)).secret === undefined, 'no activation before new-code verification');
      // Language changes cannot issue provider/auth requests or discard the pending activation.
      await page.selectOption('#ui-locale', 'zh-Hans'); await page.selectOption('#ui-locale', 'en');
      assert.ok((await page.textContent('#auth-enroll-secret')).includes(secret));
      await page.fill('#auth-enroll-code', hotp(secret, Math.floor(Date.now() / 30000))); await page.click('#auth-enroll-confirm');
      await page.waitForFunction(() => !document.getElementById('auth-recovery-output').hidden);
      const recovery = (await page.textContent('#auth-recovery-codes')).split('\n'); assert.equal(recovery.length, 8);
      await page.click('#auth-recovery-dismiss'); assert.equal(await page.textContent('#auth-enroll-secret'), ''); await loggedOut();
      phase = `${profile}-${width}-unbind`;
      await login('password'); await page.click('#auth-unbind'); await verify({ recovery: recovery[0] }); await loggedOut();
      credential = await store.read(`${config.tenant.id}:tester`); assert.ok(credential.secret === undefined, 'authenticator unbound'); assert.equal(credential.registration.email, 'synthetic@example.invalid');
      assert.equal(credential.revision, 4); assert.equal(errors.length, 0, 'no page errors'); assert.equal(offOrigin.length, 0, 'no off-origin requests');
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /secret|password|proof|otp/i.test(key))), false);
      results.push({ profile, width, initialEmailBootstrap: true, initialPassword: true, combinedTotpEnrollment: true, newCodeActivation: true,
        cancelPreservesState: true, trueUnbind: true, localePreservesEnrollment: true, noBrowserSecretPersistence: true, physicalDevice: false });
      await context.close();
    }
    console.log(JSON.stringify({ synthetic: true, actualHttpService: true, results }, null, 2));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(JSON.stringify({ error: 'AUTH_METHOD_UI_SMOKE_FAILED', phase, cause: error?.name ?? 'Error' })); process.exitCode = 1; });
