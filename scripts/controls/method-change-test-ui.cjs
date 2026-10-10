// Browser-test adapter only. Drives the real management dialog and HTTP service;
// it does not mint a proof, bypass a factor, or write production credential state.
const assert = require('node:assert/strict');
// Public stage names only. Never put arguments, selectors, DOM, responses or
// exception messages into diagnostics: those can contain private input values.
const checkpoints = new Set(['initialization', 'browser-launch', 'page-load', 'password-refusal', 'password-login', 'asset-connect',
  'setup-cancel', 'setup-expiry', 'setup-pagehide', 'setup-account-change', 'setup-late-confirm', 'setup-final-confirm',
  'totp-login', 'totp-replay', 'recovery-login', 'wallet-login', 'reload-ca-refusal', 'evidence',
  'account-settings', 'registration', 'password-settings']);
let currentCheckpoint = 'initialization', step = 'outside-change-dialog';
function checkpoint(value) {
  assert.ok(checkpoints.has(value), 'Unknown public smoke checkpoint'); currentCheckpoint = value; step = 'outside-change-dialog';
}
function registeredState(tenant, username, email, now) {
  return { [`${tenant}:${username}`]: { revision: 1, registration: { version: 1, email, verifiedAt: now - 1000 } },
    [`@registration:${tenant}`]: { version: 1, records: [{ username, email, verifiedAt: now - 1000 }] } };
}
async function result(response) { const value = await response; return { status: value.status(), body: await value.json() }; }
function changeResponse(page, stage) { return page.waitForResponse(response => response.url().endsWith(`/auth/account/change/${stage}`)); }
async function identity(page, { password, method = password === undefined ? 'wallet' : 'password', existingCode, recovery = false, answer, stage = 'verify' } = {}) {
  step = 'identity-dialog';
  const dialog = page.locator('dialog.auth-change-dialog'); await dialog.waitFor({ state: 'visible' });
  // getByLabel(exact) includes option text when the label wraps the select.
  // Check the visible caption separately, then address the sole real select.
  step = 'identity-method';
  assert.equal(await dialog.getByText('Independent verification', { exact: true }).isVisible(), true);
  const selector = dialog.locator('select'); assert.equal(await selector.count(), 1);
  await selector.selectOption(method);
  step = 'identity-factors';
  if (method === 'password') await dialog.getByLabel('Original password', { exact: true }).fill(password ?? '');
  if (existingCode !== undefined) await dialog.getByLabel('Current authenticator or saved recovery code', { exact: true }).fill(existingCode);
  if (recovery) await dialog.getByLabel('Use a saved recovery code', { exact: true }).check();
  if (answer !== undefined) await dialog.getByLabel('Existing security answer', { exact: true }).fill(answer);
  step = 'identity-submit';
  const response = changeResponse(page, stage); await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  step = 'identity-response';
  const value = await result(response); if (value.status >= 400) await page.waitForLoadState('networkidle'); return value;
}
async function email(page, code, stage = 'confirm') {
  step = 'email-input';
  const dialog = page.locator('dialog.auth-change-dialog');
  await dialog.getByLabel('Eight-digit email code', { exact: true }).fill(code);
  step = 'email-submit';
  const response = changeResponse(page, stage); await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  step = 'email-response';
  const value = await result(response); if (value.status >= 400) await page.waitForLoadState('networkidle'); return value;
}
async function authorize(page, options, getMail) {
  const verified = await identity(page, options); assert.equal(verified.status, 200, 'Synthetic combined identity verification must succeed');
  const confirmed = await email(page, getMail().code); assert.equal(confirmed.status, 200, 'Synthetic reserved-email verification must succeed');
  step = 'authorized';
  return confirmed.body;
}
async function commit(page, button, options, getMail) {
  step = 'commit-open';
  const response = changeResponse(page, 'commit'); await page.click(button);
  const proof = await authorize(page, options, getMail);
  if (proof.newEmailRequired) {
    await email(page, getMail().code, 'commit');
  }
  step = 'commit-response';
  return result(response);
}
function failure(error) {
  // Playwright and assertion diagnostics can embed input values. Log only a
  // fixed classification; never raw OTPs, seeds, passwords, mail or DOM dumps.
  console.error(JSON.stringify({ error: 'AUTH_MANAGEMENT_BROWSER_SMOKE_FAILED', checkpoint: currentCheckpoint, step,
    cause: ['Error', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'Error' }));
  process.exitCode = 1;
}
module.exports = { checkpoint, registeredState, changeResponse, identity, email, authorize, commit, result, failure };
