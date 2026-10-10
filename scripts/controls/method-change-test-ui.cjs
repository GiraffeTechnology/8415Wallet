// Browser-test adapter only. Drives the real management dialog and HTTP service;
// it does not mint a proof, bypass a factor, or write production credential state.
const assert = require('node:assert/strict');
function registeredState(tenant, username, email, now) {
  return { [`${tenant}:${username}`]: { revision: 1, registration: { version: 1, email, verifiedAt: now - 1000 } },
    [`@registration:${tenant}`]: { version: 1, records: [{ username, email, verifiedAt: now - 1000 }] } };
}
async function result(response) { const value = await response; return { status: value.status(), body: await value.json() }; }
function changeResponse(page, stage) { return page.waitForResponse(response => response.url().endsWith(`/auth/account/change/${stage}`)); }
async function identity(page, { password, method = password === undefined ? 'wallet' : 'password', existingCode, recovery = false, answer, stage = 'verify' } = {}) {
  const dialog = page.locator('dialog.auth-change-dialog'); await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('Independent verification', { exact: true }).selectOption(method);
  if (method === 'password') await dialog.getByLabel('Original password', { exact: true }).fill(password ?? '');
  if (existingCode !== undefined) await dialog.getByLabel('Current authenticator or saved recovery code', { exact: true }).fill(existingCode);
  if (recovery) await dialog.getByLabel('Use a saved recovery code', { exact: true }).check();
  if (answer !== undefined) await dialog.getByLabel('Existing security answer', { exact: true }).fill(answer);
  const response = changeResponse(page, stage); await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const value = await result(response); if (value.status >= 400) await page.waitForLoadState('networkidle'); return value;
}
async function email(page, code, stage = 'confirm') {
  const dialog = page.locator('dialog.auth-change-dialog');
  await dialog.getByLabel('Eight-digit email code', { exact: true }).fill(code);
  const response = changeResponse(page, stage); await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const value = await result(response); if (value.status >= 400) await page.waitForLoadState('networkidle'); return value;
}
async function authorize(page, options, getMail) {
  const verified = await identity(page, options); assert.equal(verified.status, 200, 'Synthetic combined identity verification must succeed');
  const confirmed = await email(page, getMail().code); assert.equal(confirmed.status, 200, 'Synthetic reserved-email verification must succeed');
  return confirmed.body;
}
async function commit(page, button, options, getMail) {
  const response = changeResponse(page, 'commit'); await page.click(button);
  const proof = await authorize(page, options, getMail);
  if (proof.newEmailRequired) {
    await email(page, getMail().code, 'commit');
  }
  return result(response);
}
function failure(error) {
  // Playwright and assertion diagnostics can embed input values. Log only a
  // fixed classification; never raw OTPs, seeds, passwords, mail or DOM dumps.
  console.error(JSON.stringify({ error: 'AUTH_MANAGEMENT_BROWSER_SMOKE_FAILED', cause: error?.name || 'Error' }));
  process.exitCode = 1;
}
module.exports = { registeredState, changeResponse, identity, email, authorize, commit, result, failure };
