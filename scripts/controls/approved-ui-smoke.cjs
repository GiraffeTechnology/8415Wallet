// Real Chromium, synthetic EIP-1193 reads/signatures only. No real transaction or device acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { spawn } = require('node:child_process'); const { chromium } = require('playwright-core');
const { installSyntheticLoginSigner } = require('./synthetic-login.cjs');
const { installScreenNavigation } = require('./screen-navigation.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.APPROVED_UI_OUTPUT || '/tmp/8415-approved-ui-evidence');
const config = JSON.parse(fs.readFileSync(path.join(root, 'web/release-config.json'), 'utf8'));
const origin = 'http://127.0.0.1:18428';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, 'serve-browser.cjs')], { env: { ...process.env, WALLET_BROWSER_PORT: '18428' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Static server exited: ${code}`))); });
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const evidence = [];
    for (const delivery of [{ profile: 'v2', tenant: { id: 'default', label: '8415wallet' } }, { profile: 'v2', tenant: { id: 'xiongan', label: 'Xiongan' } }, { profile: 'v3', tenant: { id: 'default', label: '8415wallet' } }]) for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1200 }, isMobile: width === 390 });
      const network = [], errors = [];
      await context.route('**/*', route => {
        const url = route.request().url(); network.push(url);
        if (!url.startsWith(`${origin}/`)) return route.abort();
        if (url === `${origin}/web/release-config.json`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...config, ...delivery }) });
        return route.continue();
      });
      await installSyntheticLoginSigner(context);
      await context.addInitScript(() => {
        const state = globalThis.__approvedUi = { calls: [], actor: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', listeners: new Map() };
        const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
        globalThis.ethereum = { on(event, fn) { if (!state.listeners.has(event)) state.listeners.set(event, []); state.listeners.get(event).push(fn); }, removeListener() {}, async request({ method, params = [] }) {
          state.calls.push(method);
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [state.actor];
          if (method === 'eth_chainId') return '0x1';
          if (method === 'personal_sign') return globalThis.__syntheticLoginSign(params[0]);
          if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, hash: `0x${'4'.repeat(64)}` };
          if (method === 'eth_getCode') return params[0].toLowerCase() === `0x${'3'.repeat(40)}` ? '0x6000' : '0x';
          if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
          if (method === 'eth_getTransactionCount') return '0x0';
          if (method === 'eth_estimateGas') return '0x5208';
          if (method === 'eth_call') {
            const data = params[0].data;
            if (data.startsWith('0x01ffc9a7')) return word(data.slice(10, 18) === 'ffffffff' ? 0 : 1);
            if (data.startsWith('0x6352211e')) return `0x${'0'.repeat(24)}${state.actor.slice(2).toLowerCase()}`;
            if (data.startsWith('0x00fdd58e')) return word(3);
          }
          throw new Error(`Unexpected synthetic request: ${method}`);
        } };
      });
      const page = installScreenNavigation(await context.newPage()); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await page.waitForFunction(() => document.getElementById('release-profile').textContent.includes('8415wallet'));
      await page.waitForFunction(() => document.querySelector('.brand-logo').complete && document.querySelector('.brand-logo').naturalWidth === 931);
      const privatePanel = page.locator('#wallet-private'); assert.equal(await privatePanel.isVisible(), false);
      assert.deepEqual(await page.evaluate(() => __approvedUi.calls), []);
      const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await noOverflow(); await page.screenshot({ path: path.join(out, `${delivery.profile}-${delivery.tenant.id}-${width}-login.png`) });
      await page.click('#wallet-login'); await page.waitForFunction(() => !document.getElementById('wallet-private').hidden);
      await noOverflow(); assert.equal(await page.locator('[data-page="overview"]').isVisible(), true);
      assert.equal(await page.locator('.nav-item[data-route="linked"]').isVisible(), delivery.profile === 'v3');
      const logo = await page.locator('.brand-logo').evaluate(img => ({ width: img.width, height: img.height, fit: getComputedStyle(img).objectFit, natural: img.naturalWidth }));
      assert.equal(logo.width, logo.height); assert.equal(logo.fit, 'contain'); assert.equal(logo.natural, 931);
      await page.screenshot({ path: path.join(out, `${delivery.profile}-${delivery.tenant.id}-${width}-overview.png`) });
      await page.click('#asset-connect'); await page.waitForFunction(() => document.getElementById('asset-result').textContent.includes('balanceWei'));
      await page.fill('#nft-contract', `0x${'3'.repeat(40)}`); await page.fill('#nft-token-id', '108'); await page.click('#nft-read');
      await page.waitForFunction(() => document.getElementById('nft-result').textContent.includes('blockHash'));
      assert.equal(JSON.parse(await page.textContent('#nft-result')).balanceRaw, '1');
      await page.selectOption('#nft-standard', 'ERC-1155'); await page.click('#nft-read');
      await page.waitForFunction(() => document.getElementById('nft-result').textContent.includes('"3"'));
      await page.fill('#asset-recipient', `0x${'2'.repeat(40)}`); await page.fill('#asset-amount', '1000000000000001'); await page.click('#asset-prepare');
      await page.waitForFunction(() => !document.querySelector('[data-page="review"]').hidden);
      assert.equal(await page.locator('#transfer-review-summary').textContent().then(v => v.includes(`0x${'2'.repeat(40)}`)), true);
      await page.check('#asset-ack'); await page.click('[data-ui-locale="zh-Hans"]');
      assert.equal(await page.isChecked('#asset-ack'), true); await noOverflow();
      await page.screenshot({ path: path.join(out, `${delivery.profile}-${delivery.tenant.id}-${width}-review.png`) });
      await page.keyboard.press('Escape'); assert.equal(await page.isChecked('#asset-ack'), false);
      await page.click('[data-ui-locale="en"]');
      await page.setInputFiles('#tenant-avatar-file', path.join(root, 'web/assets/giraffe-original.jpg'));
      await page.waitForFunction(() => document.getElementById('tenant-avatar-status').textContent.includes('draft'));
      await page.click('#tenant-avatar-save'); await page.waitForFunction(() => document.getElementById('tenant-avatar-status').textContent.includes('saved'));
      assert.equal(await page.locator('#tenant-avatar img').count(), 1);
      await page.click('#tenant-avatar-remove'); await page.waitForFunction(() => document.getElementById('tenant-avatar img') === null);
      await page.click('#wallet-logout'); assert.equal(await privatePanel.isVisible(), false);
      assert.equal(await page.textContent('#transfer-review-summary'), ''); assert.equal((await page.textContent('#nft-result')).includes('blockHash'), false);
      assert.equal(await page.evaluate(() => __approvedUi.calls.includes('eth_sendTransaction')), false);
      assert.deepEqual(errors, []); assert.equal(network.every(url => url.startsWith(origin)), true);
      evidence.push({ ...delivery, width, noOverflow: true, originalRaster: true, routes: true, nftReadOnly: true, reviewCancel: true, localeInvariant: true, avatarSaveRemove: true, logoutPrivacy: true, synthetic: true });
      await context.close();
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ synthetic: true, evidence }, null, 2));
    console.log(`Passed ${evidence.length} approved-UI delivery/viewport journeys`);
  } finally { await browser?.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
