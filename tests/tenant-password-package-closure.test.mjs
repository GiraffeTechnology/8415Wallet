/** Source/package contract regressions; full archive execution belongs to Control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DELIVERY_FILES } from '../scripts/package/verify-delivery.mjs';
import { validatePasswordRoutes } from '../web/tenant-password-routing.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('outer kit carries the transitive release-profile dependency and npm test runs tenant routing cases', () => {
  assert.equal(DELIVERY_FILES.filter(path => path === 'web/tenant-password-routing.mjs').length, 1);
  assert.match(read('web/release-profile.mjs'), /from '\.\/tenant-password-routing\.mjs'/);
  const script = JSON.parse(read('package.json')).scripts.test;
  for (const file of ['tests/tenant-password-routing.test.mjs', 'tests/tenant-password-package-closure.test.mjs']) {
    assert.equal(script.split(' ').filter(part => part === file).length, 1);
  }
});
test('nested V2/V3 closure is dynamically enumerated and strict packaged readiness remains false', () => {
  const build = read('scripts/package/build-dapp.mjs'), shared = read('scripts/package/dapp-release.mjs');
  assert.match(build, /stagePublicWeb\(root, source, stage\)/);
  assert.match(shared, /entry\.path\.startsWith\('web\/'\)/);
  for (const path of ['web/tenant-password-routing.mjs', 'web/tenant-password-ui.mjs', 'web/tenant-password-routing.json']) {
    assert.ok(read(path).length > 0);
    assert.ok(read('scripts/package/verify-delivery.mjs').includes("'" + path + "'"));
  }
  const routes = validatePasswordRoutes(JSON.parse(read('web/tenant-password-routing.json')));
  assert.equal(routes.length, 3); assert.ok(routes.every(row => row.passwordManagementReady === false));
});
