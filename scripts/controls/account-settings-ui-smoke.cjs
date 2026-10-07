// Real Chromium + HTTP service, synthetic credentials and in-memory email only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { installScreenNavigation } = require('./screen-navigation.cjs');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');
async function run() {
  const root = path.resolve(__dirname, '../..'), out = path.resolve(process.env.AUTH_UI_OUTPUT || '/tmp/8415-auth-methods-ui-evidence');
  const { createAuthService } = await import('../../server/auth-service.mjs');
  const { MemoryCredentialStore } = await import('../../server/store.mjs');
  const { hashPassword, hotp } = await import('../../server/crypto.mjs');
  const { LOCALES, CATALOGS } = await import('../../web/i18n.mjs');
  const password = 'synthetic-management-password', passwordHash = await hashPassword(password), answer = 'synthetic private recovery phrase';
  const actor = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
  const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
  let profile = 'v2', auth, time = Date.now(), mail = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/')) return auth(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/web/release-config.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ...config, profile })); }
    const full = path.resolve(root, req.url === '/' ? 'web/index.html' : req.url.slice(1));
    if (!full.startsWith(`${root}/web/`) && !full.startsWith(`${root}/dist/browser/`)) { res.writeHead(404); return res.end(); }
    try { res.setHeader('Content-Type', full.endsWith('.html') ? 'text/html' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : full.endsWith('.jpg') ? 'image/jpeg' : full.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript'); res.end(fs.readFileSync(full)); }
    catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const evidence = [];
  try {
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (profile of ['v2', 'v3']) for (const width of [1440, 390]) {
      time = Date.now(); mail = []; const store = new MemoryCredentialStore();
      auth = createAuthService({ origin, tenant: config.tenant.id, accounts: [{ username: 'tester', passwordHash, wallets: [{ account: actor, chainId: '1' }] }], store,
        now: () => time, sendOtp: async value => { mail.push(value); return { accepted: true }; } });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390 });
      const offOrigin = [], requests = [], errors = [];
      context.on('request', request => { if (!request.url().startsWith(`${origin}/`)) offOrigin.push(request.url()); if (request.url().includes('/auth/')) requests.push(new URL(request.url()).pathname); });
      await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const events = new Map(); globalThis.__settingsCalls = [];
        globalThis.ethereum = { on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, removeListener(name, fn) { events.get(name)?.delete(fn); },
          async request({ method, params }) { globalThis.__settingsCalls.push(method);
            if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return ['0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'];
            if (method === 'eth_chainId') return '0x1'; if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
            throw Error('Unexpected synthetic request'); } };
      });
      const page = installScreenNavigation(await context.newPage()); page.on('pageerror', error => errors.push(error.message)); await page.clock.install({ time });
      const idle = () => page.waitForFunction(() => !document.getElementById('wallet-login').disabled);
      const login = async (method = 'password') => {
        await page.selectOption('#wallet-login-method', method); if (['password', 'totp'].includes(method)) await page.fill('#auth-username', 'tester');
        if (method === 'password') await page.fill('#auth-password', password);
        await page.click('#wallet-login'); await page.waitForFunction(() => !document.getElementById('wallet-private').hidden); await idle();
        await page.click('#auth-manage-open'); await page.waitForFunction(() => !document.getElementById('auth-method-states').hidden);
      };
      const post = async (button, suffix) => { const response = page.waitForResponse(r => r.url().endsWith(`/auth/${suffix}`)); await page.click(button); return (await response).json(); };
      const confirmTotp = async () => {
        await page.waitForFunction(() => document.getElementById('auth-enroll-secret').textContent.includes('otpauth://'));
        const secret = (await page.textContent('#auth-enroll-secret')).match(/\n([A-Z2-7]{32})\n/)[1];
        await page.fill('#auth-enroll-code', hotp(secret, Math.floor(time / 30000))); await page.click('#auth-enroll-confirm');
        await page.waitForFunction(() => !document.getElementById('auth-recovery-output').hidden);
        const codes = (await page.textContent('#auth-recovery-codes')).split('\n'); await page.click('#auth-recovery-dismiss'); return { secret, codes };
      };
      await page.goto(`${origin}/web/index.html`); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      await page.locator('#ui-locale').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await page.inputValue('#ui-locale'), 'zh-Hans');
      for (const locale of LOCALES) {
        await page.selectOption('#ui-locale', locale.id);
        for (const [method, key] of [['password', 'account.loginPassword'], ['totp', 'account.loginTotp'], ['wallet', 'account.loginWallet'], ['ca', 'account.loginCa'], ['wallet-local', 'ui.018']]) {
          await page.selectOption('#wallet-login-method', method); assert.equal(await page.textContent('#wallet-login'), CATALOGS[locale.id][key]);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.deepEqual(requests, []); assert.deepEqual(await page.evaluate(() => globalThis.__settingsCalls), []);
      await page.selectOption('#ui-locale', 'en'); await page.selectOption('#wallet-login-method', 'totp');
      await page.click('#auth-initial-open'); assert.equal(await page.inputValue('#wallet-login-method'), 'wallet');
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#auth-management').isVisible(), false);
      await page.click('#auth-manage-open'); await login();
      assert.equal(await page.isChecked('#auth-enable-password'), true); assert.equal(await page.isChecked('#auth-enable-wallet'), true);
      assert.equal(await page.isDisabled('#auth-enable-ca'), true); assert.equal(await page.locator('#auth-existing-fields').isVisible(), false);
      await page.fill('#auth-reserved-email', 'reserved@example.invalid'); await page.fill('#auth-reserved-answer', answer);
      const challenge = await post('#auth-recovery-enroll', 'recovery/enroll/start'); assert.equal(challenge.digits, 8); assert.equal(mail.length, 1);
      assert.equal(await page.inputValue('#auth-reserved-answer'), ''); await page.fill('#auth-email-code', mail.at(-1).code);
      await post('#auth-email-confirm', 'recovery/enroll/confirm'); await page.waitForFunction(() => document.getElementById('wallet-private').hidden);
      await login(); assert.match(await page.textContent('#auth-recovery-state'), /r\*\*\*@example.invalid/);
      await page.click('#auth-enroll-start'); const initial = await confirmTotp(); await login();
      await page.fill('#auth-reset-answer', 'wrong synthetic phrase'); const wrong = await post('#auth-reset-start', 'recovery/reset/start'); assert.equal(wrong.error, 'AUTH_REFUSED');
      time += 61000; await page.clock.fastForward(61000);
      await page.fill('#auth-reset-answer', answer); await post('#auth-reset-start', 'recovery/reset/start'); assert.equal(mail.length, 2);
      const beforeCalls = await page.evaluate(() => globalThis.__settingsCalls.length), beforeRequests = requests.length;
      await page.selectOption('#ui-locale', 'ja'); await page.selectOption('#ui-locale', 'en');
      assert.equal(await page.evaluate(() => globalThis.__settingsCalls.length), beforeCalls); assert.equal(requests.length, beforeRequests);
      await page.fill('#auth-email-code', 'notvalid'); const wrongCode = await post('#auth-email-confirm', 'recovery/reset/confirm'); assert.equal(wrongCode.error, 'AUTH_REFUSED');
      await page.fill('#auth-email-code', mail.at(-1).code); await post('#auth-email-confirm', 'recovery/reset/confirm');
      await page.waitForFunction(() => document.getElementById('auth-recovery-verification-status').textContent.includes('verified briefly'));
      await page.fill('#auth-existing-code', initial.codes[0]); await page.check('#auth-existing-recovery'); await page.click('#auth-enroll-start');
      const replacement = await confirmTotp(); await login();
      assert.equal(await page.isChecked('#auth-enable-password'), true); assert.equal(await page.isChecked('#auth-enable-wallet'), true); assert.equal(await page.isChecked('#auth-enable-totp'), true);
      await page.uncheck('#auth-enable-totp'); await page.fill('#auth-existing-code', replacement.codes[0]); await page.check('#auth-existing-recovery');
      await post('#auth-methods-save', 'account/methods'); await page.waitForFunction(() => document.getElementById('wallet-private').hidden);
      time += 30000; await page.clock.fastForward(30000); await page.selectOption('#wallet-login-method', 'totp'); await page.fill('#auth-username', 'tester'); await page.fill('#auth-code', hotp(replacement.secret, Math.floor(time / 30000)));
      const denied = await post('#wallet-login', 'totp'); assert.equal(denied.error, 'AUTH_REFUSED'); await idle();
      await login(); assert.equal(await page.isChecked('#auth-enable-totp'), false); assert.equal(await page.isDisabled('#auth-enable-totp'), false);
      await page.uncheck('#auth-enable-password'); await page.uncheck('#auth-enable-wallet');
      const noPath = await post('#auth-methods-save', 'account/methods'); assert.equal(noPath.error, 'AUTH_INDEPENDENT_METHOD_REQUIRED');
      await page.check('#auth-enable-wallet'); await post('#auth-methods-save', 'account/methods'); await page.waitForFunction(() => document.getElementById('wallet-private').hidden);
      await login('wallet'); assert.equal(await page.isChecked('#auth-enable-password'), false); assert.equal(await page.isChecked('#auth-enable-wallet'), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(out, `${profile}-${width}-account-settings.png`), fullPage: false });
      await page.click('#auth-management-close'); assert.equal(await page.locator('#auth-management').isVisible(), false);
      await page.click('#wallet-logout'); await page.reload(); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.equal(await page.locator('#auth-method-states').isVisible(), false); assert.equal(await page.inputValue('#auth-reserved-answer'), '');
      assert.deepEqual(offOrigin, []); assert.deepEqual(errors, []);
      evidence.push({ profile, width, dropdownKeyboardAndSixLocales: true, methodLabels: true, publicEntryNoProviderOrAuthCalls: true, emailAndQuestionEnrollment: true,
        resetOnlyEmail: true, oldRecoveryPlusEmailAndAnswer: true, actualMethodPolicyPersistence: true, lastIndependentMethodProtected: true, localeNoAdditionalRequests: true,
        noOffOriginRequests: true, privateOnReload: true, noOverflow: true, syntheticOnly: true });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'account-settings-results.json'), JSON.stringify({ synthetic: true, actualHttpService: true, emailTransport: 'in-memory fake', evidence }, null, 2));
    console.log(`Passed ${evidence.length} account-settings browser journeys`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
