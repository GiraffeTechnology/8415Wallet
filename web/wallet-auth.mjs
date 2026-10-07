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
let registrationOpen = false, registrationStep = null, registrationProof = null, registrationTimer = null, registrationRevision = 0, signupClient = null, signupAuthenticating = false;
let migrationStep = null, migrationTimer = null, migrationRevision = 0;
let managementCapabilities = null, capabilityRevision = 0, passwordRevision = 0, passwordPending = false;
const methods = ['password', 'wallet', 'ca', 'totp'];
const currentSession = () => { try { return walletLogin.assert(); } catch { return null; } };
const freshManagement = () => accountState?.management.freshIndependentLogin === true && Date.now() < accountState.management.reauthenticateBy;
function enrollmentControls() {
  el('auth-enroll-start').disabled = signing || !freshManagement() || !!enrollmentId;
  el('auth-enroll-confirm').disabled = signing || !enrollmentId;
  el('auth-confirm-fields').hidden = !enrollmentId;
  el('auth-methods-save').disabled = signing || !freshManagement();
  recoveryControls(); registrationControls();
}
function clearPasswordInputs() {
  el('auth-new-password').value = ''; el('auth-new-password-confirm').value = '';
}
function clearPassword() {
  passwordRevision++; clearPasswordInputs(); paint(el('auth-password-status'), '');
}
function passwordControls() {
  const fresh = moduleOpen && !!currentSession()?.serverId && freshManagement(), supported = managementCapabilities === true;
  if (!fresh || !supported) clearPasswordInputs();
  el('auth-password-fields').hidden = !fresh || !supported;
  for (const id of ['auth-new-password', 'auth-new-password-confirm']) el(id).disabled = signing || !fresh || !supported;
  el('auth-password-save').disabled = signing || !fresh || !supported || (accountState?.recovery?.configured && !resetProof);
  el('auth-password-factor-help').hidden = !fresh || !accountState?.authenticator.enrolled;
  el('auth-password-reset-help').hidden = !fresh || !accountState?.recovery?.configured;
  paint(el('auth-password-save'), msg(accountState?.methods.password.bound ? 'account.passwordReplace' : 'account.passwordInitial'));
  paint(el('auth-password-state'), msg(managementCapabilities === false ? 'account.passwordUpgrade' : managementCapabilities === 'unavailable' ?
    'account.passwordServiceUnavailable' : !fresh ? 'account.passwordVerify' : accountState.methods.password.bound ? 'account.passwordBound' : 'account.passwordNotBound'));
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
  enrollmentControls(); renderRecovery(); renderRegistration();
}
async function loadAccount() {
  const client = accountClient, binding = walletLogin.capture(), revision = attemptRevision;
  if (!walletLogin.assert(binding).serverId || !client) return;
  paint(el('auth-management-status'), msg('account.loading'));
  managementCapabilities = client.supportsPasswordManagement;
  try {
    const value = await client.account(); walletLogin.assert(binding);
    if (client !== accountClient || revision !== attemptRevision) return;
    accountState = value;
    el('auth-registration-account-email').value = value.registration?.email ?? '';
    renderManagement(); clearTimeout(managementTimer);
    if (freshManagement()) managementTimer = setTimeout(() => { clearPassword(); clearEnrollment(); clearRecovery(); clearMigration(); el('auth-existing-code').value = ''; renderManagement(); }, Math.max(0, value.management.reauthenticateBy - Date.now()));
  } catch {
    if (client !== accountClient || revision !== attemptRevision || !currentSession()) return;
    accountState = null; renderManagement(); paint(el('auth-management-status'), msg('account.statusFailed'));
  }
}
walletLogin.subscribe((session, reason) => {
  clearTimeout(timer); clearTimeout(managementTimer); enrollmentRevision++; capabilityRevision++; accountState = null;
  clearPassword();
  if (!(signupAuthenticating && reason === 'LOGIN_STARTING')) {
    if (!session) {
      registrationRevision++; const pending = signupClient; signupClient = null;
      if (pending) void pending.cancelRegistration();
    }
    clearSignup(true);
  }
  migrationRevision++; clearMigration();
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
function cancelLogin() {
  const pendingRegistration = signupClient; signupClient = null;
  if (pendingRegistration) void pendingRegistration.cancelRegistration();
  attemptRevision++; enrollmentRevision++; recoveryRevision++; registrationRevision++; migrationRevision++; capabilityRevision++;
  clearPassword(); clearEnrollment(); clearRecovery(); clearSignup(true); clearMigration(); walletLogin.logout();
}
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
  if (!['password', 'wallet', 'ca'].includes(el('wallet-login-method').value)) el('wallet-login-method').value = 'wallet';
  renderLoginMethod(); renderManagement(); el('wallet-login-method').focus?.();
  document.dispatchEvent?.(new CustomEvent('wallet:authentication-method'));
}
async function loadManagementCapabilities() {
  const revision = ++capabilityRevision;
  try {
    const profile = await getReleaseProfile();
    if (!moduleOpen || revision !== capabilityRevision) return;
    const client = accountClient ?? new AccountAuthClient({ tenant: profile.tenant.id });
    const value = await client.capabilities();
    if (!moduleOpen || revision !== capabilityRevision) return;
    managementCapabilities = value.passwordManagement === true;
  } catch {
    if (!moduleOpen || revision !== capabilityRevision) return;
    managementCapabilities = 'unavailable';
  }
  passwordControls();
}
async function openManagement({ initial = false } = {}) {
  if (registrationOpen) closeRegistration();
  moduleOpen = true; renderManagement();
  const session = currentSession(), needsIndependentLogin = !session?.serverId || !['password', 'wallet', 'ca'].includes(session.kind);
  // A selector choice is not proof that a password exists. Initial setup must
  // offer the registered-wallet path until an independent server login exists.
  if (initial && needsIndependentLogin) el('wallet-login-method').value = 'wallet';
  if (!session?.serverId || (initial && needsIndependentLogin)) verifyAgain();
  else if (!accountState) await loadAccount();
  await loadManagementCapabilities();
  if (moduleOpen) el('auth-management-title').focus?.();
}
el('auth-initial-open').addEventListener('click', () => openManagement({ initial: true }));
el('auth-manage-open').addEventListener('click', () => openManagement());
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
  moduleOpen = false; capabilityRevision++; clearPassword();
  // A submitted confirmation may already have committed; closing never promises rollback.
  if (signing) cancelLogin(); else { void cancelSetup({ status: false }); void cancelRecovery(); void cancelMigration(); }
  renderManagement(); el('auth-manage-open').focus?.();
}
el('auth-management-close').addEventListener('click', closeManagement);
globalThis.addEventListener('popstate', () => { if (registrationOpen) closeRegistration(); else if (moduleOpen) closeManagement(); });
globalThis.addEventListener('keydown', event => { if (event.key === 'Escape') { if (registrationOpen) closeRegistration(); else if (moduleOpen) closeManagement(); } });
document.addEventListener('wallet:authentication-leaving', () => { if (moduleOpen) closeManagement(); });
async function savePassword() {
  if (signing) return;
  const body = { password: el('auth-new-password').value, purpose: accountState?.methods.password.bound ? 'replace' : 'initial',
    ...(accountState?.authenticator.enrolled ? { existingCode: el('auth-existing-code').value, recovery: el('auth-existing-recovery').checked === true } : {}),
    ...(resetProof ? { resetProof } : {}) };
  const matches = body.password === el('auth-new-password-confirm').value;
  clearPasswordInputs(); el('auth-existing-code').value = '';
  if (!moduleOpen || !accountClient || !freshManagement() || managementCapabilities !== true || (accountState?.recovery?.configured && !resetProof)) { body.password = ''; passwordControls(); return; }
  if (!matches || body.password.length < 12 || new TextEncoder().encode(body.password).length > 1024) {
    body.password = ''; paint(el('auth-password-status'), msg('account.passwordMismatch')); return;
  }
  const lock = acquireWalletUi(); if (lock === null) { body.password = ''; return; }
  signing = true; passwordPending = true; const attempt = attemptRevision, revision = ++passwordRevision;
  const client = accountClient, binding = walletLogin.capture();
  clearEnrollment(); enrollmentControls(); paint(el('auth-password-status'), msg('account.passwordSaving'));
  let submitted = false;
  try {
    await walletLogin.check(); walletLogin.assert(binding);
    if (attempt !== attemptRevision || revision !== passwordRevision || !freshManagement()) throw new WalletLoginError('LOGIN_CANCELLED');
    submitted = true; await client.setPassword(body); walletLogin.assert(binding);
    if (attempt !== attemptRevision || revision !== passwordRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    cancelLogin(); paint(el('wallet-login-status'), msg('account.passwordSaved'));
  } catch (error) {
    if (attempt !== attemptRevision || revision !== passwordRevision) return;
    // Only documented pre-commit refusals are safe to retry. Storage failures
    // can occur after the new credential reached disk; never replay those.
    const refused = error instanceof WalletLoginError && ['AUTH_REFUSED', 'AUTH_PASSWORD_INPUT_REFUSED', 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED',
      'AUTH_SETUP_STATE_CHANGED', 'AUTH_RATE_LIMITED', 'AUTH_BUSY', 'AUTH_PASSWORD_MANAGEMENT_UNAVAILABLE', 'AUTH_ROUTE_REFUSED'].includes(error.code);
    if (submitted && !refused) { cancelLogin(); paint(el('wallet-login-status'), msg('account.passwordSubmitted')); }
    else if (error instanceof WalletLoginError && ['AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED', 'AUTH_SETUP_STATE_CHANGED'].includes(error.code)) {
      cancelLogin(); paint(el('wallet-login-status'), msg(error.code === 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED' ? 'account.freshRequired' : 'account.statusFailed'));
    } else paint(el('auth-password-status'), error instanceof WalletLoginError ? error.code === 'AUTH_PASSWORD_MANAGEMENT_UNAVAILABLE' ? msg('account.passwordUpgrade') :
      error.code === 'AUTH_PASSWORD_INPUT_REFUSED' ? msg('account.passwordMismatch') : error.code : msg('account.passwordFailed'));
  } finally { body.password = ''; body.existingCode = ''; body.resetProof = ''; passwordPending = false; signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
el('auth-password-save').addEventListener('click', savePassword);
el('auth-password-recovery-link').addEventListener('click', event => {
  event?.preventDefault?.();
  if (!moduleOpen || !freshManagement() || !accountState?.recovery?.configured) return;
  el('auth-recovery-settings').scrollIntoView?.({ block: 'start' }); el('auth-reset-answer').focus?.();
});
el('auth-password-cancel').addEventListener('click', () => {
  if (passwordPending) { cancelLogin(); paint(el('wallet-login-status'), msg('account.passwordSubmitted')); }
  else { clearPassword(); el('auth-existing-code').value = ''; void cancelRecovery(); paint(el('auth-password-status'), msg('account.passwordCancelled')); }
});
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
  passwordControls();
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
  if (verified && accountState?.registration?.complete) el('auth-reserved-email').value = accountState.registration.email;
  el('auth-reserved-email').readOnly = !!accountState?.registration?.complete;
  recoveryControls();
}
async function cancelRecovery() {
  // Cancelling a proof-dependent operation also invalidates its enrollment generation.
  if (signing) { cancelLogin(); return; }
  recoveryRevision++; clearPassword(); clearRecovery();
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
      recoveryTimer = setTimeout(() => { recoveryRevision++; clearPassword(); clearRecovery(); paint(el('auth-recovery-verification-status'), msg('recovery.expired')); }, Math.max(0, result.expiresAt - Date.now()));
    }
  } catch (error) {
    if (attempt === attemptRevision && revision === recoveryRevision) paint(el('auth-recovery-verification-status'), error instanceof WalletLoginError ? error.code === 'AUTH_RATE_LIMITED' ? msg('recovery.rateLimited') : error.code : 'AUTH_RECOVERY_UNAVAILABLE');
  } finally { body.answer = ''; body.code = ''; body.existingCode = ''; body.resetProof = ''; signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
el('auth-recovery-enroll').addEventListener('click', () => runRecovery('enroll'));
el('auth-reset-start').addEventListener('click', () => runRecovery('reset'));
el('auth-email-confirm').addEventListener('click', () => runRecovery('confirm'));
el('auth-email-cancel').addEventListener('click', cancelRecovery);
function registrationControls() {
  el('auth-registration-start').disabled = signing || !!registrationStep || !!registrationProof;
  el('auth-registration-verify').disabled = signing || !registrationStep;
  el('auth-registration-finish').disabled = signing || !registrationProof;
  el('auth-registration-email').readOnly = !!registrationStep || !!registrationProof;
  el('auth-registration-code-fields').hidden = !registrationStep;
  el('auth-registration-wallet-fields').hidden = !registrationProof;
  const migrationAllowed = !signing && freshManagement() && accountState?.registration?.emailOtpAvailable === true;
  el('auth-registration-account-start').disabled = !migrationAllowed || !!migrationStep || ((accountState?.registration?.complete || accountState?.recovery?.configured) && !resetProof);
  el('auth-registration-account-confirm').disabled = !migrationAllowed || !migrationStep;
  el('auth-registration-account-cancel').hidden = !migrationStep;
  el('auth-registration-account-code-fields').hidden = !migrationStep;
  el('auth-registration-account-email').readOnly = !!migrationStep;
}
function clearSignup(hide = false) {
  clearTimeout(registrationTimer); registrationTimer = null; registrationStep = null; registrationProof = null;
  for (const id of ['auth-registration-email', 'auth-registration-code', 'auth-registration-password', 'auth-registration-password-confirm']) el(id).value = '';
  paint(el('auth-registration-status'), ''); if (hide) registrationOpen = false;
  el('auth-registration').hidden = !registrationOpen; registrationControls();
}
function clearMigration() {
  clearTimeout(migrationTimer); migrationTimer = null; migrationStep = null;
  for (const id of ['auth-registration-account-email', 'auth-registration-account-code']) el(id).value = '';
  paint(el('auth-registration-account-status'), ''); registrationControls();
}
function renderRegistration() {
  el('auth-registration').hidden = !registrationOpen;
  el('auth-registration-open').hidden = !!currentSession();
  el('auth-registration-open').setAttribute?.('aria-expanded', String(registrationOpen));
  const state = accountState?.registration, visible = !!currentSession()?.serverId && !!state;
  el('auth-registration-account').hidden = !visible;
  el('auth-registration-change-help').hidden = !visible || (!state.complete && !accountState?.recovery?.configured);
  paint(el('auth-registration-change-help'), msg(state?.complete ? 'registration.changeHelp' : 'registration.migrationProof'));
  paint(el('auth-registration-account-state'), !visible ? '' : state.complete ? msg('registration.current', { email: state.emailMasked }) : msg('registration.required'));
  if (visible && !state.emailOtpAvailable) paint(el('auth-registration-account-status'), msg('recovery.unavailable'));
  registrationControls();
}
function closeRegistration() {
  const client = signupClient; signupClient = null;
  cancelLogin(); registrationOpen = false; renderRegistration();
  if (client) {
    const attempt = attemptRevision;
    void client.cancelRegistration().then(result => {
      if (attempt === attemptRevision && !currentSession() && (result?.confirmationInProgress || result?.unconfirmed)) paint(el('wallet-login-status'), msg('registration.checkSubmitted'));
    });
  }
  el('auth-registration-open').focus?.();
}
el('auth-registration-open').addEventListener('click', () => {
  cancelLogin(); moduleOpen = false; registrationOpen = true; signupClient = null; renderManagement();
  el('auth-registration-title').focus?.();
});
el('auth-registration-close').addEventListener('click', closeRegistration);
function challengeMetadata(result) {
  if (typeof result.challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.challengeId) || result.digits !== 8 || typeof result.emailMasked !== 'string' ||
    !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
  return { challengeId: result.challengeId, expiresAt: result.expiresAt };
}
async function runSignup(action) {
  if (signing || !registrationOpen || (action === 'verify' && !registrationStep) || (action === 'finish' && !registrationProof)) return;
  if (action === 'start' && (registrationStep || registrationProof)) return;
  const password = el('auth-registration-password').value, confirmation = el('auth-registration-password-confirm').value;
  if (action === 'finish' && ((password || confirmation) && (password !== confirmation || password.length < 12 || new TextEncoder().encode(password).length > 1024))) {
    paint(el('auth-registration-status'), msg('registration.passwordMismatch')); return;
  }
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; enrollmentControls(); const revision = ++registrationRevision, attempt = attemptRevision;
  const email = el('auth-registration-email').value, step = registrationStep, proof = registrationProof;
  const code = el('auth-registration-code').value;
  el('auth-registration-code').value = ''; el('auth-registration-password').value = ''; el('auth-registration-password-confirm').value = '';
  try {
    if (action === 'start') {
      const profile = await getReleaseProfile();
      if (revision !== registrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      const client = new AccountAuthClient({ tenant: profile.tenant.id }); signupClient = client;
      const result = await client.registrationStart(email);
      if (client !== signupClient || revision !== registrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      registrationStep = challengeMetadata(result);
      paint(el('auth-registration-status'), msg('registration.codeSent', { email: result.emailMasked, expires: new Date(result.expiresAt).toISOString() }));
      registrationTimer = setTimeout(() => {
        if (signupClient !== client) return;
        signupClient = null; registrationRevision++; void client.cancelRegistration();
        if (signupAuthenticating) cancelLogin();
        clearSignup(); registrationOpen = true; renderRegistration(); paint(el('auth-registration-status'), msg('registration.expired'));
      }, Math.max(0, result.expiresAt - Date.now()));
    } else if (action === 'verify') {
      const result = await signupClient.registrationVerify(step.challengeId, code);
      if (revision !== registrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      if (result.verified !== true || typeof result.registrationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.registrationId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
      registrationStep = null; registrationProof = { id: result.registrationId, expiresAt: result.expiresAt };
      paint(el('auth-registration-status'), msg('registration.verified'));
    } else {
      const client = signupClient, credentials = { password };
      signupAuthenticating = true; accountClient = client;
      await walletLogin.signIn(globalThis.ethereum, client.registrationAdapter(proof.id, credentials));
      if (revision !== registrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
      await loadAccount(); walletLogin.assert();
      signupClient = null; registrationOpen = false; moduleOpen = true; el('auth-username').value = email; el('wallet-login-method').value = 'wallet';
      renderLoginMethod(); renderManagement(); paint(el('wallet-login-status'), msg('registration.complete'));
      document.dispatchEvent?.(new CustomEvent('wallet:authentication-method'));
      document.dispatchEvent?.(new CustomEvent('wallet:authentication-settings'));
    }
  } catch (error) {
    if (attempt === attemptRevision && (revision === registrationRevision || (action === 'finish' && error instanceof WalletLoginError && !/CANCELLED|ACCOUNT|CHAIN|DISCONNECTED|SESSION_CHANGED/.test(error.code)))) {
      if (action === 'finish') { clearSignup(); registrationOpen = true; el('auth-registration-email').value = email; renderRegistration(); }
      paint(el('auth-registration-status'), error instanceof WalletLoginError ? error.code === 'AUTH_RATE_LIMITED' ? msg('recovery.rateLimited') : error.code : 'AUTH_REGISTRATION_UNAVAILABLE');
    }
  } finally { signupAuthenticating = false; signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
el('auth-registration-start').addEventListener('click', () => runSignup('start'));
el('auth-registration-verify').addEventListener('click', () => runSignup('verify'));
el('auth-registration-finish').addEventListener('click', () => runSignup('finish'));
async function cancelMigration() {
  if (signing) { cancelLogin(); return; }
  migrationRevision++; clearMigration();
  if (accountClient && currentSession()?.serverId) { try { await accountClient.registrationEmail('cancel'); } catch { /* Already locally cleared. */ } }
}
async function runMigration(action) {
  if (signing || !accountClient || !freshManagement() || !accountState?.registration?.emailOtpAvailable || (action === 'confirm' && !migrationStep) || (action === 'start' && migrationStep)) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; enrollmentControls(); const revision = ++migrationRevision, attempt = attemptRevision, binding = walletLogin.capture();
  const client = accountClient, body = action === 'start' ? { email: el('auth-registration-account-email').value, existingCode: el('auth-existing-code').value,
    recovery: el('auth-existing-recovery').checked === true, ...(resetProof ? { resetProof } : {}) } : { challengeId: migrationStep.challengeId, code: el('auth-registration-account-code').value };
  el('auth-existing-code').value = ''; el('auth-registration-account-code').value = '';
  try {
    await walletLogin.check(); walletLogin.assert(binding);
    if (revision !== migrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    const result = await client.registrationEmail(action, body); walletLogin.assert(binding);
    if (revision !== migrationRevision || attempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    if (action === 'start') {
      migrationStep = challengeMetadata(result); resetProof = null; clearTimeout(recoveryTimer); recoveryTimer = null;
      paint(el('auth-recovery-verification-status'), '');
      paint(el('auth-registration-account-status'), msg('registration.codeSent', { email: result.emailMasked, expires: new Date(result.expiresAt).toISOString() }));
      migrationTimer = setTimeout(() => { migrationRevision++; clearMigration(); paint(el('auth-registration-account-status'), msg('registration.expired')); }, Math.max(0, result.expiresAt - Date.now()));
    } else {
      if (result.registered !== true || result.loggedOut !== true) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
      cancelLogin(); paint(el('wallet-login-status'), msg('registration.migrateDone'));
    }
  } catch (error) {
    if (revision === migrationRevision && attempt === attemptRevision) paint(el('auth-registration-account-status'), error instanceof WalletLoginError ? error.code === 'AUTH_RATE_LIMITED' ? msg('recovery.rateLimited') : error.code : 'AUTH_REGISTRATION_UNAVAILABLE');
  } finally { body.existingCode = ''; body.code = ''; body.resetProof = ''; signing = false; releaseWalletUi(lock); enrollmentControls(); }
}
el('auth-registration-account-start').addEventListener('click', () => runMigration('start'));
el('auth-registration-account-confirm').addEventListener('click', () => runMigration('confirm'));
el('auth-registration-account-cancel').addEventListener('click', cancelMigration);
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
