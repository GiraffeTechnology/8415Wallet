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
function clearEnrollment() {
  clearTimeout(enrollmentTimer); enrollmentTimer = null;
  paint(el('auth-enroll-secret'), ''); clearEnrollmentQr(el('auth-enroll-qr'));
  el('auth-enroll-qr-help').hidden = true;
}
walletLogin.subscribe((session, reason) => {
  clearTimeout(timer);
  clearEnrollment(); // Every session/identity transition removes pixels and localized secret bindings.
  el('auth-enrollment').hidden = !session?.serverId || !['password', 'wallet', 'ca'].includes(session?.kind);
  for (const id of ['auth-password', 'auth-code', 'auth-existing-code', 'auth-enroll-code']) el(id).value = '';
  if (!session) { clearTimeout(enrollmentTimer); paint(el('auth-enroll-secret'), ''); }
  el('auth-recovery-output').hidden = true; paint(el('auth-recovery-codes'), '');
  el('wallet-private').hidden = !session; el('wallet-private').inert = !session;
  el('wallet-logout').hidden = !session && !signing;
  el('wallet-login').hidden = !!session;
  paint(el('wallet-login-status'), session ? msg('status.loggedIn', { account: session.account, chain: session.chainId, expires: new Date(session.expiresAt).toISOString() }) :
    reason === 'LOGIN_EXPIRED' ? msg('message.017') : msg('ui.031'));
  if (session) timer = setTimeout(() => walletLogin.logout('LOGIN_EXPIRED'), Math.max(0, session.expiresAt - Date.now()));
});
el('wallet-login').addEventListener('click', async () => {
  if (signing) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  const currentAttempt = ++attemptRevision;
  signing = true; el('wallet-login').disabled = true; el('wallet-logout').hidden = false;
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
      // Clear DOM secrets before awaiting a provider or network response.
      el('auth-password').value = ''; el('auth-code').value = '';
      await walletLogin.signIn(globalThis.ethereum, adapter);
    }
  } catch (error) {
    if (currentAttempt !== attemptRevision) return;
    paint(el('wallet-login-status'), error instanceof WalletLoginError && error.code === 'LOGIN_REJECTED' ?
      msg('message.019') :
      error instanceof WalletLoginError ? error.code : 'LOGIN_SERVICE_OR_CONFIG_UNAVAILABLE');
  } finally {
    signing = false; el('wallet-login').disabled = false; releaseWalletUi(lock);
    try { walletLogin.assert(); } catch { el('wallet-logout').hidden = true; }
  }
});
function cancelLogin() { attemptRevision++; clearEnrollment(); walletLogin.logout(); }
el('wallet-logout').addEventListener('click', cancelLogin);
globalThis.addEventListener('pagehide', cancelLogin);
globalThis.addEventListener('pageshow', event => { if (event.persisted) cancelLogin(); });
globalThis.addEventListener('focus', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });
document.addEventListener('visibilitychange', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });

function methodChanged() {
  cancelLogin();
  const method = el('wallet-login-method').value;
  el('account-login-fields').hidden = !['password', 'totp'].includes(method);
  el('auth-password-label').hidden = method !== 'password';
  el('auth-code-label').hidden = method !== 'totp'; el('auth-recovery-label').hidden = method !== 'totp';
  el('auth-password').value = ''; el('auth-code').value = '';
  paint(el('auth-method-help'), method === 'wallet-local' ? msg('ui.017') :
    method === 'ca' ? msg('message.020') :
    msg('message.021'));
}
el('wallet-login-method').addEventListener('change', methodChanged);
async function enroll(action) {
  if (signing || !accountClient) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; const currentAttempt = attemptRevision;
  if (action !== 'start') clearEnrollment(); // Clear before awaiting confirm/cancel.
  try {
    const binding = walletLogin.capture();
    await walletLogin.check(); walletLogin.assert(binding);
    if (action === 'start') {
      const result = await accountClient.startEnrollment(el('auth-existing-code').value, el('auth-existing-recovery').checked === true);
      walletLogin.assert(binding);
      if (currentAttempt !== attemptRevision || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new WalletLoginError('AUTH_SETUP_EXPIRED');
      clearEnrollment();
      paint(el('auth-enroll-secret'), msg('auth.setupSecret', { secret: result.secret, uri: result.uri, expires: new Date(result.expiresAt).toISOString() }));
      try { renderEnrollmentQr(el('auth-enroll-qr'), result.uri); el('auth-enroll-qr-help').hidden = false; }
      catch { clearEnrollmentQr(el('auth-enroll-qr')); /* Manual entry remains usable. */ }
      enrollmentTimer = setTimeout(clearEnrollment, Math.max(0, result.expiresAt - Date.now()));
    } else if (action === 'confirm') {
      const result = await accountClient.confirmEnrollment(el('auth-enroll-code').value);
      walletLogin.assert(binding); if (currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED'); cancelLogin();
      paint(el('auth-recovery-codes'), result.recoveryCodes.join('\n')); el('auth-recovery-output').hidden = false;
    } else {
      await accountClient.cancelEnrollment(); walletLogin.assert(binding); clearEnrollment();
    }
  } catch (error) {
    clearEnrollment();
    if (currentAttempt === attemptRevision) paint(el('wallet-login-status'), error instanceof WalletLoginError ? error.code : 'AUTH_SETUP_UNAVAILABLE');
  } finally {
    el('auth-existing-code').value = ''; el('auth-enroll-code').value = ''; signing = false; releaseWalletUi(lock);
  }
}
el('auth-enroll-start').addEventListener('click', () => enroll('start'));
el('auth-enroll-confirm').addEventListener('click', () => enroll('confirm'));
el('auth-enroll-cancel').addEventListener('click', () => enroll('cancel'));
el('auth-recovery-dismiss').addEventListener('click', () => { paint(el('auth-recovery-codes'), ''); el('auth-recovery-output').hidden = true; });
