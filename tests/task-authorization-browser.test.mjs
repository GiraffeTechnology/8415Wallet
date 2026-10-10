/** Synthetic Chromium UI acceptance only; no genuine wallet, signer or live OTP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { freezeTaskPolicy, emptyTaskBudget } from '../src/agent/taskContract.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.WALLET_TASK_EVIDENCE;
async function endpoint() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
test('synthetic desktop and mobile real-page task approval, app switch, reload, navigation and six locales', async () => {
  const port = await endpoint(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['scripts/controls/serve-browser.cjs'], { cwd: root, env: { ...process.env, WALLET_BROWSER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(server.stdout, 'data');
  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.WALLET_BROWSER_CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      const account = `0x${'11'.repeat(20)}`, tenant = 'default';
      const task = freezeTaskPolicy({ schema: '8415-agent-task/1', taskId: 'synthetic-nft-sale', origin, tenant, chainId: '1', actor: account,
        expiresAt: String(Math.floor(Date.now() / 1000) + 3600), fees: { perOperationWei: '1000000000000001', totalWei: '2000000000000003' },
        intent: { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721', contract: `0x${'22'.repeat(20)}`, tokenId: '9007199254740993123', quantity: '1',
          minimumProceeds: { currency: 'USD', amountMinor: '100001', minorUnit: 2, comparison: 'gt', basis: 'net' }, marketAdapters: ['synthetic-reviewed-market'] } });
      const executorIdentity = { schema: '8415-task-executor/1', agentId: 'synthetic-agent', agentVersion: '1', adapterId: 'synthetic-test-adapter', adapterVersion: '1', implementationDigest: `0x${'9'.repeat(64)}` };
      const executor = { identity: executorIdentity, digest: `0x${createHash('sha256').update(JSON.stringify(executorIdentity)).digest('hex')}` };
      let authorized = false, session;
      const view = () => ({ observationPolicy: null, receiptVerifier: null, observations: [], observationRevision: '0', completion: { state: 'not-attempted', fresh: false }, task, executor, authorization: authorized ? { schema: '8415-task-authorization-reference/1', taskDigest: task.digest,
        reference: 'grant:synthetic', status: 'authorized', grantPolicyVersion: '1', credentialRevisionAtApproval: '0' } : null,
        effectiveStatus: authorized ? 'authorized' : 'pending', budget: authorized ? emptyTaskBudget(task) : null,
        capabilities: { executable: false, adapterConfigured: false, receiptVerifierConfigured: false, missing: ['USER_CONTROLLED_SIGNER_NOT_CONNECTED', 'MARKET_PRICE_VERIFIER_NOT_CONNECTED'] } });
      await page.addInitScript(({ account }) => { window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return '0x1'; throw Error('No synthetic signing or transaction permission');
      } }; }, { account });
      await page.route('**/auth/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.slice(6), body = request.postData() ? request.postDataJSON() : null;
        requests.push(path); let data;
        if (path === 'capabilities') data = { schema: '8415wallet-auth/1', origin, tenant, methods: ['password', 'totp', 'wallet', 'ca'], passwordManagement: true };
        else if (path === 'bootstrap') data = { csrf: 'c'.repeat(43) };
        else if (path === 'password') { const issuedAt = Date.now(); session = { id: 's'.repeat(43), csrf: 'c'.repeat(43), origin, tenant, username: 'synthetic', account, chainId: '1', kind: 'password', issuedAt, expiresAt: issuedAt + 900000 }; data = session; }
        else if (path === 'session') data = session;
        else if (path === 'account') data = { schema: '8415wallet-account/1', origin, tenant, username: 'synthetic', account, chainId: '1',
          methods: { password: { enabled: true, bound: true }, wallet: { enabled: true, bound: true }, ca: { enabled: false, bound: false }, totp: { enabled: true, bound: true } },
          authenticator: { enrolled: true, pending: false }, management: { freshIndependentLogin: true, reauthenticateBy: Date.now() + 300000, existingCodeRequired: true },
          registration: { required: false, complete: true, email: 'synthetic@example.invalid', emailMasked: 's***@example.invalid', emailOtpAvailable: false },
          recovery: { configured: false, emailOtpAvailable: false } };
        else if (path === 'logout') data = { loggedOut: true };
        else if (path === 'tasks/list') data = { tasks: [view()], nextCursor: null, revision: '1' };
        else if (path === 'tasks/status') data = view();
        else if (path === 'tasks/prepare') data = { task, executor, observationPolicy: null, receiptVerifier: null, purpose: 'authorize-task', challengeId: `challenge:${'c'.repeat(43)}`, expiresAt: Date.now() + 120000 };
        else if (path === 'tasks/authorize') { assert.equal(body.taskDigest, task.digest); assert.equal(body.code, '123456'); assert.equal(body.executorDigest, executor.digest); assert.equal(body.observationPolicyDigest, null); authorized = true; data = view(); }
        else if (path === 'tasks/resume') data = { ...view(), continuation: { state: 'blocked', code: 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED' } };
        else { await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"AUTH_ROUTE_REFUSED"}' }); return; }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      });
      const login = async () => {
        await page.locator('#wallet-login-method').selectOption('password'); await page.locator('#auth-username').fill('synthetic');
        await page.locator('#auth-password').fill('SYNTHETIC_TEST_PASSWORD'); await page.locator('#wallet-login').click();
        await page.waitForFunction(() => !document.body.classList.contains('signed-out'));
      };
      await page.goto(`${origin}/web/index.html`); await login();
      await page.locator('[data-route="tasks"]').first().click(); await page.locator('.task-list-item').click();
      await page.locator('#task-authorize-fields').waitFor({ state: 'visible' });
      assert.match(await page.locator('#task-summary').innerText(), /> 1000\.01 USD/);
      assert.match(await page.locator('#task-summary').innerText(), /9007199254740993123/);
      const prepareCount = requests.filter(path => path === 'tasks/prepare').length;
      await page.locator('#task-code').fill('654321'); await page.locator('#task-ack').check();
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(await page.locator('#task-code').inputValue(), '');
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(requests.filter(path => path === 'tasks/prepare').length, prepareCount);
      assert.equal(await page.locator('#task-authorize-fields').isVisible(), true);
      const canonicalPolicy = page.locator('#task-canonical');
      // The policy is an intentionally collapsed disclosure. Inspect its exact
      // stored text, then open it through the user control before testing layout.
      assert.equal(await canonicalPolicy.textContent(), JSON.stringify(task.policy, null, 2));
      await canonicalPolicy.locator('..').locator('summary').click();
      await canonicalPolicy.waitFor({ state: 'visible' });
      assert.equal(await canonicalPolicy.innerText(), JSON.stringify(task.policy, null, 2));
      for (const locale of ['zh-Hans', 'zh-Hant', 'fr', 'es', 'ja', 'en']) {
        await page.locator('#ui-locale').selectOption(locale);
        assert.equal(await canonicalPolicy.isVisible(), true, `${locale}: canonical policy remains visible`);
        assert.equal(await canonicalPolicy.innerText(), JSON.stringify(task.policy, null, 2));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewport.width}:${locale}: no horizontal overflow`);
      }
      assert.equal(requests.filter(path => path === 'tasks/prepare').length, prepareCount);
      if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/task-review-${viewport.width}.png`, fullPage: true }); }
      await page.locator('#task-cancel').click(); assert.equal(await page.locator('#task-authorize-fields').isVisible(), false);
      await page.locator('#task-recheck').click(); await page.locator('#task-authorize-fields').waitFor({ state: 'visible' });
      await page.locator('[data-route="activity"]').first().click(); await page.goBack();
      await page.locator('#task-authorize-fields').waitFor({ state: 'visible' });
      await page.locator('#task-code').fill('123456'); await page.locator('#task-ack').check(); await page.locator('#task-authorize').click();
      await page.waitForFunction(() => document.getElementById('task-status').textContent.includes('continuation blocked'));
      assert.equal(await page.locator('#task-code').inputValue(), ''); assert.ok(requests.includes('tasks/resume'));
      assert.equal(requests.filter(path => path === 'tasks/authorize').length, 1);
      await page.reload(); await login();
      await page.waitForFunction(() => document.getElementById('task-status').textContent.includes('continuation blocked'));
      assert.equal(await page.locator('#task-page').isVisible(), true);
      assert.equal(requests.filter(path => path === 'tasks/authorize').length, 1);
      assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state })), JSON.stringify({ local: { '8415wallet.ui.locale.v1': 'en' }, session: {}, history: { walletPage: 'tasks', walletTaskDigest: task.digest } }));
      if (evidence) await page.screenshot({ path: `${evidence}/task-authorized-blocked-${viewport.width}.png`, fullPage: true });
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser?.close(); server.kill('SIGTERM'); }
});
