const { installScreenNavigation } = require('./screen-navigation.cjs');
// Real Chromium page, synthetic provider only. Never a genuine-wallet/device claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.I18N_UI_OUTPUT || '/tmp/8415-i18n-ui-evidence');
async function main() {
  const { CATALOGS, LOCALES } = await import('../../web/i18n.mjs');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
  let profile = 'v2';
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/web/release-config.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...config, profile })); return; }
    const relative = req.url === '/' ? 'web/index.html' : req.url.slice(1), full = path.resolve(root, relative);
    if (!full.startsWith(`${root}/web/`) && !full.startsWith(`${root}/dist/browser/`)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', full.endsWith('.html') ? 'text/html' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : full.endsWith('.jpg') ? 'image/jpeg' : full.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript'); res.end(fs.readFileSync(full)); }
    catch { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const evidence = [];
  try {
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (profile of ['v2', 'v3']) for (const width of [1440, 390]) for (const locale of LOCALES) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390 });
      await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const listeners = new Map();
        const state = globalThis.__localeTest = { calls: [], actor: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' };
        globalThis.ethereum = { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
          removeListener(name, fn) { listeners.get(name)?.delete(fn); }, async request({ method, params }) {
            state.calls.push(method);
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [state.actor];
            if (method === 'eth_chainId') return '0x1';
            if (method === 'eth_getCode') return '0x';
            if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
            if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'4'.repeat(64)}` };
            if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
            if (method === 'eth_getTransactionCount') return '0x0';
            if (method === 'eth_estimateGas') return '0x5208';
            throw new Error(`Unexpected synthetic method: ${method}`);
          } };
      });
      const page = installScreenNavigation(await context.newPage()), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/web/index.html`);
      await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      await page.selectOption('#ui-locale', locale.id);
      assert.equal(await page.getAttribute('html', 'lang'), locale.id);
      assert.equal(await page.textContent('#login-heading'), CATALOGS[locale.id]['ui.005']);
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => globalThis.__localeTest.calls), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.click('#wallet-login'); await page.waitForFunction(() => !document.getElementById('wallet-private').hidden);
      await page.click('#asset-connect'); await page.waitForFunction(() => document.getElementById('asset-result').textContent.includes('balanceWei'));
      await page.fill('#asset-recipient', `0x${'2'.repeat(40)}`); await page.fill('#asset-amount', '1000000000000001');
      await page.click('#asset-prepare'); await page.waitForFunction(() => document.getElementById('asset-review-text').textContent.includes('digest'));
      await page.check('#asset-ack');
      const before = JSON.parse(await page.textContent('#asset-review-text'));
      const calls = await page.evaluate(() => globalThis.__localeTest.calls.length);
      await page.selectOption('#ui-locale', 'en'); await page.selectOption('#ui-locale', locale.id);
      assert.equal(await page.evaluate(() => globalThis.__localeTest.calls.length), calls);
      const after = JSON.parse(await page.textContent('#asset-review-text'));
      for (const key of ['digest', 'amount', 'transaction']) assert.deepEqual(after[key], before[key]);
      assert.equal(await page.isChecked('#asset-ack'), true);
      assert.equal(await page.inputValue('#asset-amount'), '1000000000000001');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(out, `${profile}-${width}-${locale.id}.png`), fullPage: false });
      await page.click('#wallet-logout'); await page.selectOption('#ui-locale', 'fr'); await page.selectOption('#ui-locale', locale.id);
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      assert.equal(await page.getAttribute('#wallet-private', 'inert'), '');
      assert.equal((await page.textContent('#asset-review-text')).includes(before.digest), false);
      await page.reload(); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      assert.equal(await page.getAttribute('html', 'lang'), locale.id);
      assert.equal(await page.locator('#wallet-private').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => globalThis.__localeTest.calls), []);
      assert.deepEqual(errors, []);
      evidence.push({ profile, width, locale: locale.id, privateOnEntry: true, persistence: true, rawIntentUnchanged: true, consentUnchanged: true, switchMakesZeroProviderCalls: true, logoutPrivate: true, noOverflow: true });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ synthetic: true, evidence }, null, 2));
    console.log(`Passed ${evidence.length} rendered locale/profile/viewport journeys`);
  } finally { await browser?.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
