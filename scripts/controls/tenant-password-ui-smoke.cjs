// Synthetic Chromium regression only. Every request is fulfilled from local
// fixtures/files or aborted; no production site, login, credential or mail is used.
// Build first: npm run wallet:browser:build
// Optional immutable baseline: TENANT_UI_SOURCE_REF=<local snapshot commit>
// Optional evidence: TENANT_UI_OUTPUT=/tmp/8415-tenant-password-ui
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const tenants = ['xiongan', 'giraffe', 'lala'];
const buttons = ['auth-initial-open', 'auth-manage-open'];
const sourceRef = process.env.TENANT_UI_SOURCE_REF || null;
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const cache = new Map();
function source(relative) {
  if (!cache.has(relative)) cache.set(relative, sourceRef && relative.startsWith('web/')
    ? execFileSync('git', ['show', `${sourceRef}:${relative}`], { cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    : fs.readFileSync(path.join(root, relative)));
  return cache.get(relative);
}
function profile(tenant, url) {
  return { schema: '8415wallet-release/1', product: '8415wallet', platform: '8415wallet.com',
    profile: tenant === 'xiongan' ? 'v2' : 'v3', tenant: { id: tenant, label: tenant },
    deployment: { environment: url ? 'sin' : 'unconfigured', url } };
}
function routes(urlFor = tenant => `https://${tenant}.8415wallet.com:9446/web/index.html`, ready = true) {
  return { schema: '8415wallet-password-routing/1', entries: tenants.map(tenant => ({ tenant,
    profile: tenant === 'xiongan' ? 'v2' : 'v3', url: urlFor(tenant), passwordManagementReady: ready })) };
}
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));

async function run() {
  const out = path.resolve(process.env.TENANT_UI_OUTPUT || '/tmp/8415-tenant-password-ui');
  fs.mkdirSync(out, { recursive: true });
  let browser;
  const evidence = [], failures = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  async function scenario(name, test) {
    try { const details = await test(); evidence.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, error: error.message }); evidence.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  async function fixture({ url, config, routing = routes(), holdConfig = false, failConfig = false, holdCapabilities = false }) {
    const configGate = gate(), capabilitiesGate = gate(), configSeen = gate(), capabilitiesSeen = gate();
    if (!holdConfig) configGate.resolve(); if (!holdCapabilities) capabilitiesGate.resolve();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(10000);
    const requests = [], auth = [], unexpected = [], errors = [], fulfilled = [];
    await context.addInitScript(() => {
      globalThis.__tenantProviderCalls = [];
      globalThis.ethereum = { on() {}, removeListener() {}, request({ method }) {
        globalThis.__tenantProviderCalls.push(method); return Promise.reject(Error('Synthetic navigation must not call a provider'));
      } };
    });
    await context.route('**/*', async route => {
      const request = route.request(), actual = new URL(request.url()); requests.push(request.url());
      const finish = async value => { fulfilled.push(request.url()); return route.fulfill(value); };
      // The fixture must never leak network traffic, even for a surprising URL.
      if (actual.origin !== new URL(url).origin) { unexpected.push(request.url()); return route.abort(); }
      if (actual.pathname === '/favicon.ico') return finish({ status: 204, body: '' });
      if (actual.pathname.endsWith('/web/release-config.json')) {
        configSeen.resolve(); await configGate.promise;
        return finish({ status: failConfig ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failConfig ? { error: 'SYNTHETIC_CONFIG_UNAVAILABLE' } : config) });
      }
      if (actual.pathname === '/.well-known/8415wallet-password-routing.json' || actual.pathname.endsWith('/web/tenant-password-routing.json')) {
        return finish({ status: 200, contentType: 'application/json', body: JSON.stringify(routing) });
      }
      if (actual.pathname.startsWith('/auth/')) {
        auth.push({ path: actual.pathname, method: request.method(), origin: actual.origin, tenant: request.headers()['x-wallet-tenant'] });
        if (actual.pathname === '/auth/capabilities') {
          capabilitiesSeen.resolve(); await capabilitiesGate.promise;
          return finish({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: '8415wallet-auth/1',
            tenant: config.tenant.id, origin: actual.origin, methods: ['password', 'wallet'], passwordManagement: true }) });
        }
        unexpected.push(request.url()); return route.abort();
      }
      const match = actual.pathname.match(/\/(web\/.*|dist\/browser\/.*)$/);
      if (!match || request.method() !== 'GET' || match[1].split('/').some(part => part === '..' || part === '.')) {
        unexpected.push(request.url()); return route.abort();
      }
      try { return finish({ status: 200, contentType: mime[path.extname(match[1])] || 'application/octet-stream', body: source(match[1]) }); }
      catch { unexpected.push(request.url()); return route.abort(); }
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await configSeen.promise;
    // Ensure the actual application listeners are installed, without reaching
    // into auth state or removing hidden/inert/disabled protections.
    await page.evaluate(() => import(new URL('./wallet-auth.mjs', location.href)));
    const state = () => page.evaluate(ids => ({
      closed: document.getElementById('auth-management').hidden,
      selector: !document.getElementById('platform-password-tenants').hidden,
      buttons: ids.map(id => ({ id, disabled: document.getElementById(id).disabled, hidden: document.getElementById(id).hidden,
        expanded: document.getElementById(id).getAttribute('aria-expanded') })),
      privateHidden: document.getElementById('wallet-private').hidden,
      passwordHidden: document.getElementById('auth-password-fields').hidden,
      passwordDisabled: document.getElementById('auth-password-save').disabled,
      method: document.getElementById('wallet-login-method').value,
      providerCalls: globalThis.__tenantProviderCalls,
    }), buttons);
    const releaseConfig = async () => { configGate.resolve(); await page.waitForLoadState('networkidle'); await settle(page); };
    const safety = async () => {
      assert.deepEqual(unexpected, [], 'No unexpected or off-origin request'); assert.deepEqual(errors, [], 'No uncaught page errors');
      const value = await state(); assert.deepEqual(value.providerCalls, [], 'No provider operations');
      check(value.privateHidden && value.passwordHidden && value.passwordDisabled, 'Navigation must not authenticate or enable password writes');
      check(auth.every(row => row.path === '/auth/capabilities' && row.method === 'GET' && row.origin === new URL(url).origin && row.tenant === config.tenant.id), 'Capabilities must remain tenant-bound and same-origin');
    };
    const close = async () => { configGate.resolve(); capabilitiesGate.resolve(); await context.close(); };
    return { context, page, auth, requests, state, releaseConfig, safety, close, capabilitiesGate, capabilitiesSeen, fulfilled };
  }

  try {
    browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const tenant of ['default', 'xiongan']) for (const button of buttons) {
      await scenario(`delayed ${tenant} ${button}`, async () => {
        const url = tenant === 'default' ? 'https://8415wallet.com:9446/v3/web/index.html' : 'https://xiongan.8415wallet.com:9446/web/index.html';
        const f = await fixture({ url, config: profile(tenant, url), holdConfig: true });
        try {
          const before = await f.state();
          // Real click if exposed, then an adversarial programmatic event. A
          // disabled button alone must not substitute for the handler's guard.
          if (!before.buttons.find(row => row.id === button).disabled) await f.page.click(`#${button}`);
          await f.page.dispatchEvent(`#${button}`, 'click'); await settle(f.page);
          const pending = await f.state(), pendingAuth = f.auth.length;
          await f.releaseConfig(); const after = await f.state();
          await f.page.screenshot({ path: path.join(out, `${tenant}-${button}.png`), fullPage: true });
          const observations = { pending, after, auth: f.auth };
          const problems = [];
          if (!before.buttons.every(row => row.disabled)) problems.push('entry buttons were enabled before verified config');
          if (!pending.closed) problems.push('management opened while config pending');
          if (pendingAuth !== 0) problems.push('auth request before config');
          if (tenant === 'default') {
            if (!after.closed || !after.selector || !after.buttons.every(row => row.disabled && row.hidden)) problems.push('apex did not remain closed with only tenant selector');
            if (f.auth.length) problems.push('apex requested auth capabilities');
          } else {
            if (!after.closed || after.selector || after.buttons.some(row => row.disabled)) problems.push('tenant resolution did not enable a closed local entry');
            await f.page.click(`#${button}`); await f.page.waitForLoadState('networkidle');
            check(!(await f.state()).closed, 'Resolved tenant entry must open local panel');
            await f.page.click('#auth-management-close'); check((await f.state()).closed, 'Close must dismiss panel');
            await f.page.click(`#${button}`); await f.page.waitForLoadState('networkidle');
            check(!(await f.state()).closed, 'Repeated entry must reopen');
            await f.page.keyboard.press('Escape'); check((await f.state()).closed, 'Escape must dismiss reopened panel');
          }
          await f.safety();
          if (problems.length) throw Error(`${problems.join('; ')}; observed=${JSON.stringify(observations)}`);
          return { pendingClosed: true, pendingAuthRequests: 0, apexSelector: tenant === 'default', localReopen: tenant !== 'default' };
        } finally { await f.close(); }
      });
    }
    for (const button of buttons) await scenario(`failed config ${button}`, async () => {
      const url = 'https://xiongan.8415wallet.com:9446/web/index.html';
      const f = await fixture({ url, config: profile('xiongan', url), failConfig: true });
      try {
        await f.releaseConfig(); await f.page.dispatchEvent(`#${button}`, 'click'); await settle(f.page);
        const state = await f.state();
        check(state.closed && !state.selector && state.buttons.every(row => row.disabled), 'Rejected release config must leave both entry buttons disabled and panel closed');
        assert.deepEqual(f.auth, []); await f.safety(); return { failClosed: true };
      } finally { await f.close(); }
    });

    for (const variant of ['original', 'alternate-port', 'nested-path', 'default-https', 'explicit-default-https']) {
      const target = tenant => variant === 'alternate-port' ? `https://${tenant}.8415wallet.com:19446/web/index.html`
        : variant === 'nested-path' ? `https://${tenant}.8415wallet.com:9446/tenant/${tenant}/web/index.html`
          : variant === 'default-https' ? `https://${tenant}.8415wallet.com/web/index.html`
            : variant === 'explicit-default-https' ? `https://${tenant}.8415wallet.com:443/web/index.html` : `https://${tenant}.8415wallet.com:9446/web/index.html`;
      await scenario(`platform routes ${variant}`, async () => {
        const url = 'https://8415wallet.com:9446/v3/web/index.html';
        const f = await fixture({ url, config: profile('default', url), routing: routes(target) });
        try {
          await f.releaseConfig(); check((await f.state()).selector, 'Apex must show tenant selection');
          for (const tenant of tenants) for (const action of ['initial', 'manage']) {
            await f.page.selectOption('#password-tenant-select', tenant); await f.page.selectOption('#password-tenant-action', action);
            assert.equal(await f.page.getAttribute('#password-tenant-continue', 'href'), `${target(tenant)}#auth-${action}`, 'Preserve exact configured endpoint and only add fixed fragment');
            assert.equal(await f.page.getAttribute('#password-tenant-continue', 'aria-disabled'), 'false');
          }
          assert.deepEqual(f.auth, []); await f.safety(); return { tenantActionCombinations: 6, noTenantProbes: true };
        } finally { await f.close(); }
      });
      for (const tenant of tenants) for (const action of ['initial', 'manage']) await scenario(`destination ${variant} ${tenant} ${action}`, async () => {
        const endpoint = target(tenant), f = await fixture({ url: `${endpoint}#auth-${action}`, config: profile(tenant, endpoint), holdConfig: true });
        try {
          check((await f.state()).closed, 'Fragment panel must remain closed until config verifies'); assert.deepEqual(f.auth, []);
          await f.releaseConfig();
          check(!(await f.state()).closed, 'Verified destination fragment must open its local panel');
          assert.equal(f.page.url(), new URL(endpoint).href, 'Consumed fragment must be removed without changing the configured endpoint');
          assert.equal(f.auth.length, 1, 'Fragment must make only one local capability lookup');
          await f.page.click('#auth-management-close'); await settle(f.page); check((await f.state()).closed, 'Close must stay closed after fragment consumption');
          assert.equal(f.page.url(), new URL(endpoint).href); await f.safety(); return { exactDestination: true, fragmentConsumed: true, noAuthentication: true };
        } finally { await f.close(); }
      });
    }

    for (const [name, bad] of Object.entries({
      'cross-tenant': 'https://lala.8415wallet.com:9446/web/index.html',
      'foreign-host': 'https://attacker.invalid:9446/web/index.html',
      query: 'https://giraffe.8415wallet.com:9446/web/index.html?tenant=xiongan',
      hash: 'https://giraffe.8415wallet.com:9446/web/index.html#auth-initial',
      credentials: 'https://user:synthetic@giraffe.8415wallet.com:9446/web/index.html',
      insecure: 'http://giraffe.8415wallet.com:9446/web/index.html',
    })) await scenario(`platform refuses ${name}`, async () => {
      const url = 'https://8415wallet.com:9446/v3/web/index.html', routing = routes(); routing.entries[1].url = bad;
      const f = await fixture({ url, config: profile('default', url), routing });
      try {
        await f.releaseConfig(); await f.page.selectOption('#password-tenant-select', 'giraffe');
        assert.equal(await f.page.getAttribute('#password-tenant-continue', 'href'), null);
        assert.equal(await f.page.getAttribute('#password-tenant-continue', 'aria-disabled'), 'true');
        assert.deepEqual(f.auth, []); await f.safety(); return { navigationRefused: true };
      } finally { await f.close(); }
    });

    const expected = 'https://giraffe.8415wallet.com:19446/nested/web/index.html';
    for (const [name, actual] of Object.entries({
      'cross-tenant': expected.replace('giraffe.', 'lala.') + '#auth-initial',
      'foreign-host': expected.replace('giraffe.8415wallet.com', 'attacker.invalid') + '#auth-initial',
      'different-port': expected.replace(':19446', ':19447') + '#auth-initial',
      'different-path': expected.replace('/nested/', '/other/') + '#auth-initial',
      query: expected + '?tenant=lala#auth-initial', hash: expected + '#auth-initial?tenant=lala',
    })) await scenario(`destination refuses ${name}`, async () => {
      const f = await fixture({ url: actual, config: profile('giraffe', expected) });
      try {
        await f.releaseConfig();
        for (const button of buttons) await f.page.dispatchEvent(`#${button}`, 'click');
        await settle(f.page); const state = await f.state();
        check(state.closed && state.buttons.every(row => row.disabled), 'Mismatched destination must keep local management closed and disabled');
        assert.equal(f.page.url(), actual); assert.deepEqual(f.auth, []); await f.safety(); return { exactBindingEnforced: true };
      } finally { await f.close(); }
    });

    await scenario('close during delayed capabilities then reopen', async () => {
      const url = 'https://xiongan.8415wallet.com:9446/web/index.html';
      const f = await fixture({ url, config: profile('xiongan', url), holdCapabilities: true });
      try {
        // Config is fulfilled, but there is no capability lookup until an action.
        await f.releaseConfig(); await f.page.click('#auth-initial-open'); await f.capabilitiesSeen.promise;
        await f.page.click('#auth-management-close'); check((await f.state()).closed, 'Close must work while capabilities are pending');
        f.capabilitiesGate.resolve(); await f.page.waitForLoadState('networkidle'); check((await f.state()).closed, 'Late capabilities must not reopen dismissed panel');
        await f.page.click('#auth-manage-open'); await f.page.waitForLoadState('networkidle'); check(!(await f.state()).closed, 'Reopen after dismissal must still work');
        await f.page.click('#auth-management-close'); await f.safety(); return { staleResponseDiscarded: true, reopen: true };
      } finally { await f.close(); }
    });

    for (const button of buttons) await scenario(`unconfigured standalone ${button}`, async () => {
      const url = 'https://8415wallet.com:9446/web/index.html';
      const f = await fixture({ url, config: profile('default', null) });
      try {
        await f.releaseConfig(); check(!(await f.state()).selector, 'Unconfigured standalone retains local management');
        await f.page.click(`#${button}`); await f.page.waitForLoadState('networkidle'); check(!(await f.state()).closed, 'Verified standalone config must enable local management');
        await f.safety(); return { standalonePreserved: true };
      } finally { await f.close(); }
    });
  } finally {
    await browser?.close();
    fs.writeFileSync(path.join(out, 'tenant-password-results.json'), JSON.stringify({ synthetic: true,
      sourceRef: sourceRef || 'working-tree', allNetworkRequestsIntercepted: true,
      actualAuthenticationService: false, browserStarted: !!browser, passed: evidence.length - failures.length, failed: failures.length, evidence }, null, 2));
  }
  console.log(JSON.stringify({ passed: evidence.length - failures.length, failed: failures.length, output: out }));
  assert.equal(failures.length, 0, `${failures.length} tenant-password browser regressions failed`);
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
