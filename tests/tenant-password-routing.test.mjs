import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PASSWORD_TENANTS, validatePasswordRoutes, passwordTenantDestination, passwordPanelAction, loadPasswordRoutes } from '../web/tenant-password-routing.mjs';
import { resolveReleaseProfile, verifyReleaseLocation } from '../web/release-profile.mjs';
const file = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const defaults = () => JSON.parse(file('web/tenant-password-routing.json'));
const enabled = () => { const v = defaults(); v.entries.forEach(e => { e.passwordManagementReady = true; }); return v; };
const profile = (tenant = 'xiongan') => resolveReleaseProfile({
  schema: '8415wallet-release/1', product: '8415wallet', platform: '8415wallet.com',
  profile: tenant === 'xiongan' ? 'v2' : 'v3', tenant: { id: tenant, label: tenant },
  deployment: { environment: 'sin', url: tenant === 'default' ? 'https://8415wallet.com:9446/v3/web/index.html' :
    `https://${tenant}.8415wallet.com:9446/web/index.html` }
});
test('packaged defaults never announce existing or new tenants as ready', () => {
  const routes = validatePasswordRoutes(defaults());
  for (const tenant of PASSWORD_TENANTS) {
    assert.equal(routes.find(e => e.tenant === tenant).passwordManagementReady, false);
    assert.throws(() => passwordTenantDestination(routes, tenant, 'initial'), /NOT_DEPLOYED/);
  }
});
for (const tenant of PASSWORD_TENANTS) test(`fixed ${tenant} navigation preserves exact origin and includes no credentials`, () => {
  const routes = validatePasswordRoutes(enabled());
  for (const action of ['initial', 'manage']) {
    const target = passwordTenantDestination(routes, tenant, action), url = new URL(target);
    assert.equal(url.origin, `https://${tenant}.8415wallet.com:9446`);
    assert.equal(url.pathname, '/web/index.html'); assert.equal(url.search, '');
    assert.equal(url.username + url.password, '');
    assert.equal(passwordPanelAction(profile(tenant), url), action);
    assert.equal(verifyReleaseLocation(profile(tenant), url).tenant.id, tenant);
  }
});
test('unknown action/tenant and caller-injected destination are refused', () => {
  const routes = validatePasswordRoutes(enabled());
  for (const action of ['constructor', 'login', 'initial?secret=x']) assert.throws(() => passwordTenantDestination(routes, 'xiongan', action));
  assert.throws(() => passwordTenantDestination(routes, 'default', 'initial'));
  const v = enabled(); v.entries[0].url = 'https://attacker.invalid:9446/web/index.html';
  assert.throws(() => passwordTenantDestination(v.entries, 'xiongan', 'initial'));
});
test('readiness requires complete unique exact-schema tenant/profile/url evidence', () => {
  for (const damage of [v => v.entries.pop(), v => { v.entries[1] = v.entries[0]; },
    v => { v.entries[0].profile = 'v3'; }, v => { v.entries[1].passwordManagementReady = 'true'; },
    v => { v.entries[1].url = null; }, v => { v.approval = true; }, v => { v.entries[0].key = 'not-permitted'; }]) {
    const v = enabled(); damage(v); assert.throws(() => validatePasswordRoutes(v));
  }
});
for (const bad of ['https://giraffe.8415wallet.com/web/index.html', 'https://giraffe.8415wallet.com:9445/web/index.html',
  'https://giraffe.8415wallet.com:9446/v3/web/index.html', 'http://giraffe.8415wallet.com:9446/web/index.html',
  'https://u:p@giraffe.8415wallet.com:9446/web/index.html', 'https://giraffe.8415wallet.com:9446/web/index.html?tenant=xiongan',
  'https://giraffe.8415wallet.com:9446/web/index.html#auth-initial']) test(`routing refuses changed endpoint ${bad}`, () => {
  const v = enabled(); v.entries[1].url = bad; assert.throws(() => validatePasswordRoutes(v));
});
test('fixed panel hints do not relax origin/path/query or default-tenant location gates', () => {
  for (const suffix of ['#secret', '?password=test#auth-initial', '#auth-initial?tenant=giraffe'])
    assert.throws(() => verifyReleaseLocation(profile(), { href: profile().deployment.url + suffix }));
  assert.throws(() => verifyReleaseLocation(profile(), new URL(profile('lala').deployment.url + '#auth-initial')));
  assert.throws(() => verifyReleaseLocation(profile('default'), new URL(profile('default').deployment.url + '#auth-initial')));
});
test('operator public readiness is read same-origin without credentials or redirects', async () => {
  const calls = [];
  const routes = await loadPasswordRoutes(async (url, options) => {
    calls.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify(enabled()) };
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].url.pathname, '/.well-known/8415wallet-password-routing.json');
  assert.deepEqual(calls[0].options, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  assert.equal(routes.length, 3);
});
test('missing public status falls back only to immutable not-ready defaults', async () => {
  let count = 0;
  const routes = await loadPasswordRoutes(async () => ++count === 1 ? { ok: false, status: 404 } :
    { ok: true, status: 200, text: async () => JSON.stringify(defaults()) });
  assert.equal(count, 2); assert.ok(routes.every(row => !row.passwordManagementReady));
});
test('failed/oversize/malformed public status remains fail-closed', async () => {
  for (const response of [{ ok: false, status: 500 }, { ok: true, text: async () => '{' },
    { ok: true, text: async () => ' '.repeat(8193) }]) await assert.rejects(loadPasswordRoutes(async () => response));
});
test('platform markup and local receiver keep secrets and authentication on the destination tenant', () => {
  const html = file('web/index.html'), ui = file('web/tenant-password-ui.mjs'), receiver = file('web/wallet-auth.mjs');
  for (const id of ['platform-password-tenants', 'password-tenant-select', 'password-tenant-action', 'password-tenant-continue']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /referrerpolicy="no-referrer"/); assert.match(ui, /walletUiBusy\(\)/);
  assert.doesNotMatch(ui, /postMessage|localStorage|sessionStorage|setPassword|signIn|credentials:\s*'include'/);
  assert.match(receiver, /return openManagement\(\{ initial: action === 'initial' \}\)/);
  assert.match(receiver, /history\.replaceState/);
});
