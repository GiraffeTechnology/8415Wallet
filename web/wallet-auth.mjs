import { msg, paint } from './i18n.mjs';
import { WalletLogin, WalletLoginError } from './login-core.mjs';
import { AccountAuthClient } from './account-auth.mjs';
import { verifyMessage, getAddress, hashMessage, Interface } from '../dist/browser/vendor/ethers.js';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';
import { clearEnrollmentQr, renderEnrollmentQr } from './enrollment-qr.mjs';

export { WalletLoginError };
export const walletLogin = new WalletLogin({ crypto: { verifyMessage, getAddress, hashMessage, Interface }, origin: () => globalThis.location.origin });
const el = id => document.getElementById(id);
let timer = null, signing = false, attemptRevision = 0, accountClient = null, enrollmentTimer = null;
let moduleOpen = false, accountState = null, managementTimer = null, enrollmentId = null, enrollmentRevision = 0;
let recoveryStep = null, resetProof = null, recoveryTimer = null, recoveryRevision = 0;
const methods = ['password', 'wallet', 'ca', 'totp'];
const currentSession = () => { try { return walletLogin.assert(); } catch { return null; } };
const freshManagement = () => accountState?.management.freshIndependentLogin === true && Date.now() < accountState.management.reauthenticateBy;
function enrollmentControls() {
  el('auth-enroll-start').disabled = signing || !freshManagement() || !!enrollmentId;
  el('auth-enroll-confirm').disabled = signing || !enrollmentId;
  el('auth-confirm-fields').hidden = !enrollmentId;
  el('auth-methods-save').disabled = signing || !freshManagement();
  recoveryControls();
}
function hideEnrollmentSecret() {
  paint(el('auth-enroll-secret'), ''); clearEnrollmentQr(el('auth-enroll-qr'));
  el('auth-enroll-qr-help').hidden = true;
}
function clearEnrollment() {
  clearTimeout(enrollmentTimer); enrollmentTimer = null; enrollmentId = null;
  hideEnrollmentSecret(); el('auth-enroll-code').value = ''; enrollmentControls();
}
function renderManagement() {
  el('auth-management').hidden = !moduleOpen;
  for (const id of ['auth-initial-open', 'auth-manage-open']) el(id).setAttribute?.('aria-expanded', String(moduleOpen));
  const session = currentSession(), verified = !!session?.serverId && !!accountState, fresh = verified && freshManagement();
  el('auth-method-states').hidden = !verified;
  el('auth-enrollment').hidden = !verified || !fresh;
  el('auth-existing-fields').hidden = !verified || !accountState.authenticator.enrolled;
  el('auth-reauthenticate').hidden = !moduleOpen || (verified && fresh);
  for (const method of methods) paint(el(`auth-state-${method}`), verified ? msg(accountState.methods[method].bound ?
    accountState.methods[method].enabled ? 'account.enabled' : accountState.methods[method].available === false ? 'account.unavailable' : 'account.disabled' : 'account.notBound') : '');
  for (const method of methods) {
    el(`auth-enable-${method}`).checked = verified && accountState.methods[method].enabled;
    el(`auth-enable-${method}`).disabled = !fresh || !accountState?.methods[method].bound || accountState?.methods[method].available === false;
  }
  paint(el('auth-management-status'), msg(verified ? fresh ? 'account.ready' : 'account.freshRequired' : 'account.signInRequired'));
  paint(el('auth-enrollment-title'), msg(accountState?.authenticator.enrolled ? 'account.reset' : 'ui.020'));
  paint(el('auth-enroll-start'), msg(accountState?.authenticator.enrolled ? 'account.reset' : 'ui.024'));
  el('auth-initial-guide').hidden = verified && accountState.authenticator.enrolled;
  el('auth-reset-guide').hidden = verified && !accountState.authenticator.enrolled;
  enrollmentControls(); renderRecovery();
}
async function loadAccount() {
  const client = accountClient, binding = walletLogin.capture(), revision = attemptRevision;
  if (!walletLogin.assert(binding).serverId || !client) return;
  paint(el('auth-management-status'), msg('account.loading'));
  try {
    const value = await client.account(); walletLogin.assert(binding);
    if (client !== accountClient || revision !== attemptRevision) return;
    accountState = value; renderManagement(); clearTimeout(managementTimer);
    if (freshManagement()) managementTimer = setTimeout(() => { clearEnrollment(); clearRecovery(); renderManagement(); }, Math.max(0, value.management.reauthenticateBy - Date.now()));
  } catch {
    if (client !== accountClient || revision !== attemptRevision || !currentSession()) return;
    accountState = null; renderManagement(); paint(el('auth-management-status'), msg('account.statusFailed'));
  }
}
walletLogin.subscribe((session, reason) => {
  clearTimeout(timer); clearTimeout(managementTimer); enrollmentRevision++; accountState = null;
  clearEnrollment(); clearRecovery(); // Session/identity transitions remove pixels and localized secret bindings.
  for (const id of ['auth-password', 'auth-code', 'auth-existing-code', 'auth-enroll-code']) el(id).value = '';
  el('auth-recovery-output').hidden = true; paint(el('auth-recovery-codes'), '');
  el('wallet-private').hidden = !session; el('wallet-private').inert = !session;
  el('wallet-logout').hidden = !session && !signing; el('wallet-login').hidden = !!session;
  paint(el('wallet-login-status'), session ? msg('status.loggedIn', { account: session.account, chain: session.chainId, expires: new Date(session.expiresAt).toISOString() }) :
    reason === 'LOGIN_EXPIRED' ? msg('message.017') : msg('ui.031'));
  renderManagement();
  if (session) timer = setTimeout(() => walletLogin.logout('LOGIN_EXPIRED'), Math.max(0, session.expiresAt - Date.now()));
});
el('wallet-login').addEventListener('click', async () => {
  if (signing) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  const currentAttempt = ++attemptRevision;
  signing = true; el('wallet-login').disabled = true; el('wallet-logout').hidden = false; enrollmentControls();
  try {
    const profile = await getReleaseProfile().catch(() => { throw new WalletLoginError('LOGIN_RELEASE_CONFIG_REFUSED'); });
    if (currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    paint(el('wallet-login-status'), msg('message.018'));
    const method = el('wallet-login-method').value || 'wallet-local';
    const credentials = { username: el('auth-username').value, password: el('auth-password').value, code: el('auth-code').value, recovery: el('auth-recovery').checked === true };
    if (method === 'wallet-local') { accountClient = null; await walletLogin.signIn(globalThis.ethereum); }
    else {
      accountClient = new AccountAuthClient({ tenant: profile.tenant.id });
      const adapter = accountClient.adapter(method, credentials);
      el('auth-password').value = ''; el('auth-code').value = '';
      await walletLogin.signIn(globalThis.ethereum, adapter);
      if (currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      await loadAccount();
    }
    if (moduleOpen && currentAttempt === attemptRevision) document.dispatchEvent?.(new CustomEvent('wallet:authentication-settings'));
  } catch (error) {
    if (currentAttempt !== attemptRevision) return;
    paint(el('wallet-login-status'), error instanceof WalletLoginError && error.code === 'LOGIN_REJECTED' ? msg('message.019') :
      error instanceof WalletLoginError ? error.code : 'LOGIN_SERVICE_OR_CONFIG_UNAVAILABLE');
  } finally {
    signing = false; el('wallet-login').disabled = false; releaseWalletUi(lock); enrollmentControls();
    try { walletLogin.assert(); } catch { el('wallet-logout').hidden = true; }
  }
});
function cancelLogin() { attemptRevision++; enrollmentRevision++; recoveryRevision++; clearEnrollment(); clearRecovery(); walletLogin.logout(); }
el('wallet-logout').addEventListener('click', cancelLogin);
globalThis.addEventListener('pagehide', cancelLogin);
globalThis.addEventListener('pageshow', event => { if (event.persisted) cancelLogin(); });
globalThis.addEventListener('focus', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });
document.addEventListener('visibilitychange', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });

function renderLoginMethod() {
  const method = el('wallet-login-method').value || 'wallet-local';
  el('account-login-fields').hidden = !['password', 'totp'].includes(method);
  el('auth-password-label').hidden = method !== 'password';
  el('auth-code-label').hidden = method !== 'totp'; el('auth-recovery-label').hidden = method !== 'totp';
  const labels = { 'wallet-local': 'ui.018', password: 'account.loginPassword', totp: el('auth-recovery').checked ? 'account.loginRecovery' : 'account.loginTotp', wallet: 'account.loginWallet', ca: 'account.loginCa' };
  paint(el('wallet-login'), msg(labels[method] ?? 'ui.018'));
  paint(el('auth-method-help'), method === 'wallet-local' ? msg('ui.017') : method === 'ca' ? msg('message.020') : msg('message.021'));
}
function methodChanged() { cancelLogin(); el('auth-password').value = ''; el('auth-code').value = ''; renderLoginMethod(); }
el('wallet-login-method').addEventListener('change', methodChanged);
el('auth-recovery').addEventListener('change', renderLoginMethod);
function verifyAgain() {
  cancelLogin(); accountState = null;
  if (!['password', 'wallet', 'ca'].includes(el('wallet-login-method').value)) el('wallet-login-method').value = 'password';
  renderLoginMethod(); renderManagement(); el('wallet-login-method').focus?.();
  document.dispatchEvent?.(new CustomEvent('wallet:authentication-method'));
}
async function openManagement() {
  moduleOpen = true; renderManagement();
  if (!currentSession()?.serverId) verifyAgain();
  else if (!accountState) await loadAccount();
  if (moduleOpen) el('auth-management-title').focus?.();
}
el('auth-initial-open').addEventListener('click', openManagement);
el('auth-manage-open').addEventListener('click', openManagement);
el('auth-reauthenticate').addEventListener('click', verifyAgain);
async function cancelSetup({ status = true } = {}) {
  const id = enrollmentId, revision = ++enrollmentRevision, client = accountClient, session = currentSession();
  const binding = session ? walletLogin.capture() : null;
  clearEnrollment(); el('auth-existing-code').value = '';
  if (!session?.serverId || !client) return;
  try {
    const result = await client.cancelEnrollment(id);
    walletLogin.assert(binding);
    if (status && revision === enrollmentRevision) paint(el('auth-management-status'), result.confirmationInProgress ? 'AUTH_CONFIRMATION_IN_PROGRESS' : msg('account.cancelled'));
  } catch (error) {
    if (status && revision === enrollmentRevision && currentSession()) paint(el('auth-management-status'), error instanceof WalletLoginError ? error.code : 'AUTH_SETUP_UNAVAILABLE');
  }
}
function closeManagement() {
  moduleOpen = false;
  // A submitted confirmation may already have committed; closing never promises rollback.
  if (signing) cancelLogin(); else { void cancelSetup({ status: false }); void cancelRecovery(); }
  renderManagement(); el('auth-manage-open').focus?.();
}
el('auth-management-close').addEventListener('click', closeManagement);
globalThis.addEventListener('popstate', () => { if (moduleOpen) closeManagement(); });
globalThis.addEventListener('keydown', event => { if (event.key === 'Escape' && moduleOpen) closeManagement(); });
document.addEventListener('wallet:authentication-leaving', () => { if (moduleOpen) closeManagement(); });
async function enroll(action) {
  if (signing || !accountClient || !freshManagement() || (action === 'start' && enrollmentId) || (action === 'confirm' && !enrollmentId)) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; const currentAttempt = attemptRevision, revision = ++enrollmentRevision, client = accountClient;
  const pendingId = enrollmentId, code = el('auth-enroll-code').value, existingCode = el('auth-existing-code').value;
  const recovery = el('auth-existing-recovery').checked === true, purpose = accountState.authenticator.enrolled ? 'replace' : 'initial';
  el('auth-existing-code').value = ''; el('auth-enroll-code').value = '';
  if (action === 'confirm') hideEnrollmentSecret(); enrollmentControls();
  try {
    const binding = walletLogin.capture(); await walletLogin.check(); walletLogin.assert(binding);
    if (revision !== enrollmentRevision || currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    if (action === 'start') {
      const proof = resetProof;
      const result = await client.startEnrollment(existingCode, recovery, purpose, proof);
      walletLogin.assert(binding);
      if (revision !== enrollmentRevision || currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() || typeof result.enrollmentId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.enrollmentId)) throw new WalletLoginError('AUTH_SETUP_EXPIRED');
      clearEnrollment(); enrollmentId = result.enrollmentId;
      resetProof = null; clearTimeout(recoveryTimer); recoveryTimer = null; paint(el('auth-recovery-verification-status'), '');
      paint(el('auth-enroll-secret'), msg('auth.setupSecret', { secret: result.secret, uri: result.uri, expires: new Date(result.expiresAt).toISOString() }));
      try { renderEnrollmentQr(el('auth-enroll-qr'), result.uri); el('auth-enroll-qr-help').hidden = false; }
      catch { clearEnrollmentQr(el('auth-enroll-qr')); }
      enrollmentTimer = setTimeout(() => { enrollmentRevision++; clearEnrollment(); }, Math.max(0, result.expiresAt - Date.now()));
    } else {
      const result = await client.confirmEnrollment(code, pendingId);
      walletLogin.assert(binding);
      if (revision !== enrollmentRevision || currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      cancelLogin(); moduleOpen = false; renderManagement();
      paint(el('auth-recovery-codes'), result.recoveryCodes.join('\n')); el('auth-recovery-output').hidden = false;
    }
  } catch (error) {
    if (revision === enrollmentRevision && !(action === 'confirm' && error instanceof WalletLoginError && error.code === 'AUTH_REFUSED')) clearEnrollment();
    if (revision === enrollmentRevision && currentAttempt === attemptRevision) paint(el('wallet-login-status'), error instanceof WalletLoginError ? error.code : 'AUTH_SETUP_UNAVAILABLE');
  } finally { signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
function recoveryControls() {
  const usable = !signing && freshManagement() && accountState?.recovery?.emailOtpAvailable === true;
  el('auth-recovery-enroll').disabled = !usable || !!recoveryStep || (accountState?.recovery?.configured && !resetProof);
  el('auth-reset-start').disabled = !usable || !!recoveryStep || !accountState?.recovery?.configured;
  el('auth-email-confirm').disabled = !usable || !recoveryStep;
  el('auth-email-code-fields').hidden = !recoveryStep;
  el('auth-email-cancel').hidden = !recoveryStep && !resetProof;
  el('auth-reserve-fields').hidden = !!accountState?.recovery?.configured && !resetProof;
}
function clearRecovery() {
  clearTimeout(recoveryTimer); recoveryTimer = null; recoveryStep = null; resetProof = null;
  for (const id of ['auth-reset-answer', 'auth-reserved-answer', 'auth-reserved-email', 'auth-email-code']) el(id).value = '';
  paint(el('auth-recovery-verification-status'), ''); recoveryControls();
}
function renderRecovery() {
  const state = accountState?.recovery, verified = !!currentSession()?.serverId && !!state;
  el('auth-recovery-settings').hidden = !verified;
  el('auth-reset-reserved').hidden = !verified || !state.configured;
  paint(el('auth-recovery-state'), !verified ? '' : !state.emailOtpAvailable ? msg('recovery.unavailable') :
    state.configured ? msg('recovery.configured', { email: state.emailMasked }) : msg('recovery.notConfigured'));
  paint(el('auth-reserved-question'), verified && state.configured ? msg(`recovery.question.${state.questionId}`) : '');
  recoveryControls();
}
async function cancelRecovery() {
  // Cancelling a proof-dependent operation also invalidates its enrollment generation.
  if (signing) { cancelLogin(); return; }
  recoveryRevision++; clearRecovery();
  const client = accountClient, session = currentSession();
  if (client && session?.serverId) { try { await client.recovery('cancel'); } catch { /* Local private state is already cleared. */ } }
}
async function runRecovery(action) {
  if (signing || !accountClient || !freshManagement() || !accountState?.recovery?.emailOtpAvailable) return;
  if (action === 'confirm' && !recoveryStep) return;
  if (action !== 'confirm' && recoveryStep) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; enrollmentControls(); const attempt = attemptRevision, revision = ++recoveryRevision;
  const binding = walletLogin.capture(), client = accountClient;
  const pending = recoveryStep;
  const kind = action === 'confirm' ? pending.kind : action;
  const body = action === 'confirm' ? { challengeId: pending.challengeId, code: el('auth-email-code').value } :
    action === 'reset' ? { answer: el('auth-reset-answer').value } : {
      email: el('auth-reserved-email').value, questionId: el('auth-reserved-question-id').value,
      answer: el('auth-reserved-answer').value, existingCode: el('auth-existing-code').value,
      recovery: el('auth-existing-recovery').checked === true, ...(resetProof ? { resetProof } : {}),
    };
  for (const id of ['auth-email-code', 'auth-reset-answer', 'auth-reserved-answer', 'auth-existing-code']) el(id).value = '';
  if (action !== 'confirm') { if (action === 'reset') resetProof = null; clearEnrollment(); }
  try {
    await walletLogin.check(); walletLogin.assert(binding);
    if (attempt !== attemptRevision || revision !== recoveryRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    const result = await client.recovery(`${kind}/${action === 'confirm' ? 'confirm' : 'start'}`, body);
    walletLogin.assert(binding);
    if (attempt !== attemptRevision || revision !== recoveryRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    if (action === 'confirm' && kind === 'enroll') {
      cancelLogin(); paint(el('wallet-login-status'), msg('recovery.saved'));
    } else {
      if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new WalletLoginError('AUTH_SETUP_EXPIRED');
      clearTimeout(recoveryTimer);
      if (action === 'confirm') {
        if (typeof result.resetProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.resetProof)) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
        recoveryStep = null; resetProof = result.resetProof; paint(el('auth-recovery-verification-status'), msg('recovery.proofReady'));
      } else {
        if (typeof result.challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.challengeId) || result.digits !== 8 || typeof result.emailMasked !== 'string') throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
        resetProof = null; recoveryStep = { kind, challengeId: result.challengeId, expiresAt: result.expiresAt };
        paint(el('auth-recovery-verification-status'), msg('recovery.sent', { email: result.emailMasked, expires: new Date(result.expiresAt).toISOString() }));
      }
      recoveryTimer = setTimeout(() => { recoveryRevision++; clearRecovery(); paint(el('auth-recovery-verification-status'), msg('recovery.expired')); }, Math.max(0, result.expiresAt - Date.now()));
    }
  } catch (error) {
    if (attempt === attemptRevision && revision === recoveryRevision) paint(el('auth-recovery-verification-status'), error instanceof WalletLoginError ? error.code === 'AUTH_RATE_LIMITED' ? msg('recovery.rateLimited') : error.code : 'AUTH_RECOVERY_UNAVAILABLE');
  } finally { body.answer = ''; body.code = ''; body.existingCode = ''; body.resetProof = ''; signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
el('auth-recovery-enroll').addEventListener('click', () => runRecovery('enroll'));
el('auth-reset-start').addEventListener('click', () => runRecovery('reset'));
el('auth-email-confirm').addEventListener('click', () => runRecovery('confirm'));
el('auth-email-cancel').addEventListener('click', cancelRecovery);
el('auth-methods-save').addEventListener('click', async () => {
  if (signing || !accountClient || !freshManagement()) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; enrollmentControls(); const revision = attemptRevision, binding = walletLogin.capture(), client = accountClient;
  const enabledMethods = methods.filter(method => el(`auth-enable-${method}`).checked);
  const existingCode = el('auth-existing-code').value, recovery = el('auth-existing-recovery').checked === true;
  el('auth-existing-code').value = ''; clearEnrollment();
  try {
    await walletLogin.check(); walletLogin.assert(binding);
    if (revision !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    await client.setMethods(enabledMethods, existingCode, recovery);
    walletLogin.assert(binding); if (revision !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    cancelLogin(); paint(el('wallet-login-status'), msg('account.methodsSaved'));
  } catch (error) {
    if (revision === attemptRevision) paint(el('auth-management-status'), error instanceof WalletLoginError ? error.code : 'AUTH_MANAGEMENT_UNAVAILABLE');
  } finally { signing = false; releaseWalletUi(lock); enrollmentControls(); }
});
el('auth-enroll-start').addEventListener('click', () => enroll('start'));
el('auth-enroll-confirm').addEventListener('click', () => enroll('confirm'));
el('auth-enroll-cancel').addEventListener('click', () => cancelSetup());
el('auth-recovery-dismiss').addEventListener('click', () => { paint(el('auth-recovery-codes'), ''); el('auth-recovery-output').hidden = true; });
renderLoginMethod(); renderManagement();
