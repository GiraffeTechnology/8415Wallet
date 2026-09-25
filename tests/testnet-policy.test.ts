import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { confirmationWaitMs } = createRequire(import.meta.url)('../scripts/controls/public-testnet.cjs');
const { observeJourney } = createRequire(import.meta.url)('../scripts/controls/observe-journey.cjs');

test('testnet wait policy scales monotonically across all supported depths and stays bounded', () => {
  assert.equal(confirmationWaitMs(1), 180000); assert.equal(confirmationWaitMs(64), 1692000);
  for (let n = 2; n <= 64; n++) {
    assert.equal(confirmationWaitMs(n) - confirmationWaitMs(n - 1), 24000);
    assert.ok(confirmationWaitMs(n) < 1800000);
  }
});
test('invalid confirmation budgets fail closed instead of becoming infinite or coerced waits', () => {
  for (const n of [0, -1, 65, 1.5, NaN, Infinity, '64', null, undefined]) {
    assert.throws(() => confirmationWaitMs(n), /TESTNET_CONFIRMATIONS_REFUSED/);
  }
});

test('journey observation refuses unknown phases before touching the provider', async () => {
  for(const phase of ['', 'ui-pass', 'final', undefined]) {
    await assert.rejects(observeJourney({}, {}, phase, {funded:false}), /SCENARIO_OBSERVATION_PHASE_REFUSED/);
  }
});
